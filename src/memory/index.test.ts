/**
 * Tests for the memory layer. Each test gets a fresh tempdir so the
 * suite is hermetic — no shared state between cases, and no risk of
 * stepping on the operator's real memory.db at ~/.agentic-treasury/.
 *
 *   node --experimental-strip-types --no-warnings --test src/memory/index.test.ts
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  recordSubmission,
  updateSubmissionStatus,
  getSubmission,
  listSubmissions,
  recordEvent,
  recentEvents,
  recordLesson,
  getLessons,
  markLessonApplied,
  hasSeenListing,
  resetMemoryForTests,
} from './index.ts';
import { openDatabase } from './db.ts';

/**
 * Point AGENTIC_TREASURY_MEMORY_DB at a fresh tempdir for one test, run
 * `fn`, then reset the singleton so the next test gets its own DB.
 *
 * We pass the DB filename explicitly (rather than letting the resolver
 * fall back to ~/.agentic-treasury/memory.db) so a misconfigured env
 * doesn't accidentally smear test data into the user's real memory.
 */
function withTempDb(fn: () => void | Promise<void>): () => Promise<void> {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    const dbPath = join(dir, 'memory.db');
    const prior = process.env['AGENTIC_TREASURY_MEMORY_DB'];
    process.env['AGENTIC_TREASURY_MEMORY_DB'] = dbPath;
    resetMemoryForTests();
    try {
      await fn();
    } finally {
      resetMemoryForTests();
      if (prior === undefined) delete process.env['AGENTIC_TREASURY_MEMORY_DB'];
      else process.env['AGENTIC_TREASURY_MEMORY_DB'] = prior;
    }
  };
}

// ---------------------------------------------------------------------------
// Schema / migration
// ---------------------------------------------------------------------------

test('openDatabase migrates the schema and is idempotent', withTempDb(() => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-idem-'));
  const dbPath = join(dir, 'memory.db');
  const db1 = openDatabase(dbPath);
  const db2 = openDatabase(dbPath); // re-open without dropping — must not error
  const tables = db1
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;
  const names = tables.map(t => t.name);
  assert.ok(names.includes('submissions'), 'submissions table exists');
  assert.ok(names.includes('events'), 'events table exists');
  assert.ok(names.includes('lessons'), 'lessons table exists');
  db1.close();
  db2.close();
}));

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

test('recordSubmission then getSubmission round-trips all fields', withTempDb(() => {
  const submittedAt = new Date('2026-05-01T12:00:00Z');
  recordSubmission({
    id: 'sub-1',
    platform: 'superteam',
    listingId: 'listing-abc',
    listingTitle: 'Trepa Docs Bounty',
    submittedAt,
    status: 'pending',
    rewardUsd: 1500,
    metadata: { token: 'USDC', notes: 'four-article submission' },
  });
  const got = getSubmission('sub-1');
  assert.ok(got, 'submission found');
  assert.equal(got!.id, 'sub-1');
  assert.equal(got!.platform, 'superteam');
  assert.equal(got!.listingId, 'listing-abc');
  assert.equal(got!.listingTitle, 'Trepa Docs Bounty');
  assert.equal(got!.status, 'pending');
  assert.equal(got!.rewardUsd, 1500);
  assert.equal(got!.submittedAt.getTime(), submittedAt.getTime());
  assert.equal(got!.paidAt, null);
  assert.deepEqual(got!.metadata, { token: 'USDC', notes: 'four-article submission' });
}));

test('getSubmission returns null for unknown id', withTempDb(() => {
  assert.equal(getSubmission('does-not-exist'), null);
}));

test('updateSubmissionStatus preserves other fields and updates paid_at', withTempDb(() => {
  recordSubmission({
    id: 'sub-2',
    platform: 'superteam',
    listingId: 'listing-xyz',
    listingTitle: 'Original Title',
    status: 'pending',
    rewardUsd: 620,
    metadata: { foo: 'bar' },
  });
  const paidAt = new Date('2026-05-10T08:00:00Z');
  updateSubmissionStatus('sub-2', 'paid', 620, paidAt);
  const after = getSubmission('sub-2');
  assert.ok(after);
  assert.equal(after!.status, 'paid');
  assert.equal(after!.rewardUsd, 620);
  assert.equal(after!.paidAt?.getTime(), paidAt.getTime());
  // Untouched fields survive
  assert.equal(after!.listingTitle, 'Original Title');
  assert.deepEqual(after!.metadata, { foo: 'bar' });
}));

test('updateSubmissionStatus throws for unknown id', withTempDb(() => {
  assert.throws(() => updateSubmissionStatus('ghost', 'won'), /no submission with id=ghost/);
}));

test('listSubmissions filters by platform and status', withTempDb(() => {
  recordSubmission({ id: 'a', platform: 'superteam', listingId: 'l-a', status: 'pending' });
  recordSubmission({ id: 'b', platform: 'superteam', listingId: 'l-b', status: 'won' });
  recordSubmission({ id: 'c', platform: 'devpost',   listingId: 'l-c', status: 'pending' });
  recordSubmission({ id: 'd', platform: 'devpost',   listingId: 'l-d', status: 'lost' });

  assert.equal(listSubmissions().length, 4);
  assert.equal(listSubmissions({ platform: 'superteam' }).length, 2);
  assert.equal(listSubmissions({ status: 'pending' }).length, 2);
  const superPending = listSubmissions({ platform: 'superteam', status: 'pending' });
  assert.equal(superPending.length, 1);
  assert.equal(superPending[0]!.id, 'a');
}));

test('recordSubmission upserts on duplicate id without dropping fields', withTempDb(() => {
  recordSubmission({
    id: 'dup',
    platform: 'superteam',
    listingId: 'l-1',
    listingTitle: 'First seen title',
    status: 'pending',
    rewardUsd: 100,
    metadata: { v: 1 },
  });
  // Re-record with sparser data — must not erase the title we already
  // have, must update status.
  recordSubmission({
    id: 'dup',
    platform: 'superteam',
    listingId: 'l-1',
    status: 'won',
  });
  const got = getSubmission('dup');
  assert.ok(got);
  assert.equal(got!.status, 'won');
  assert.equal(got!.listingTitle, 'First seen title', 'title preserved on upsert');
  assert.equal(got!.rewardUsd, 100, 'reward preserved on upsert');
  assert.deepEqual(got!.metadata, { v: 1 }, 'metadata preserved on upsert');
}));

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('recordEvent + recentEvents return in reverse chronological order', withTempDb(() => {
  const t0 = Date.now();
  recordEvent({ kind: 'cycle.start', ts: new Date(t0) });
  recordEvent({ kind: 'bounty.seen', subjectId: 'b-1', ts: new Date(t0 + 1000) });
  recordEvent({ kind: 'cycle.error', payload: { msg: 'rate limited' }, ts: new Date(t0 + 2000) });

  const all = recentEvents();
  assert.equal(all.length, 3);
  assert.equal(all[0]!.kind, 'cycle.error');
  assert.equal(all[1]!.kind, 'bounty.seen');
  assert.equal(all[2]!.kind, 'cycle.start');
  assert.deepEqual(all[0]!.payload, { msg: 'rate limited' });
}));

test('recentEvents filters by kind and sinceMs window', withTempDb(() => {
  const t0 = Date.now();
  recordEvent({ kind: 'bounty.seen', subjectId: 'old', ts: new Date(t0 - 60 * 60_000) });
  recordEvent({ kind: 'bounty.seen', subjectId: 'recent', ts: new Date(t0 - 60_000) });
  recordEvent({ kind: 'gig.executed', subjectId: 'other', ts: new Date(t0 - 30_000) });

  const recentSeen = recentEvents({ kind: 'bounty.seen', sinceMs: t0 - 5 * 60_000 });
  assert.equal(recentSeen.length, 1);
  assert.equal(recentSeen[0]!.subjectId, 'recent');

  const allSeen = recentEvents({ kind: 'bounty.seen' });
  assert.equal(allSeen.length, 2);
}));

test('recentEvents honors limit', withTempDb(() => {
  for (let i = 0; i < 20; i++) {
    recordEvent({ kind: 'cycle.start', ts: new Date(Date.now() + i) });
  }
  assert.equal(recentEvents({ limit: 5 }).length, 5);
  assert.equal(recentEvents().length, 20);
}));

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

test('recordLesson + getLessons CRUD with applied counter', withTempDb(() => {
  recordLesson({
    category: 'superteam.content_bounty',
    summary: 'Sponsor accepts threads; do not submit long-form essays',
    evidence: { submissionId: 'sub-raze', outcome: 'rejected for length' },
  });
  recordLesson({
    category: 'superteam.content_bounty',
    summary: 'Submit before the 24h window closes — late submissions auto-rejected',
  });
  recordLesson({
    category: 'github.bounty.code',
    summary: 'Always include reproduction steps in the PR description',
  });

  const content = getLessons('superteam.content_bounty');
  assert.equal(content.length, 2);
  assert.ok(content[0]!.createdAt.getTime() >= content[1]!.createdAt.getTime(), 'newest first');
  assert.equal(content[0]!.appliedCount, 0);

  const github = getLessons('github.bounty.code');
  assert.equal(github.length, 1);

  // Apply the first lesson twice and verify the counter
  markLessonApplied(content[0]!.id);
  markLessonApplied(content[0]!.id);
  const after = getLessons('superteam.content_bounty');
  const reloaded = after.find(l => l.id === content[0]!.id);
  assert.equal(reloaded!.appliedCount, 2);
}));

test('getLessons returns empty list for unknown category', withTempDb(() => {
  assert.deepEqual(getLessons('nope.never'), []);
}));

// ---------------------------------------------------------------------------
// hasSeenListing
// ---------------------------------------------------------------------------

test('hasSeenListing returns true after recordSubmission', withTempDb(() => {
  assert.equal(hasSeenListing('superteam', 'listing-99'), false);
  recordSubmission({
    id: 'sub-99',
    platform: 'superteam',
    listingId: 'listing-99',
    status: 'pending',
  });
  assert.equal(hasSeenListing('superteam', 'listing-99'), true);
  // Different platform with same listing id is NOT seen
  assert.equal(hasSeenListing('devpost', 'listing-99'), false);
}));

test('hasSeenListing returns true after a bounty.seen event with matching channel', withTempDb(() => {
  recordEvent({
    kind: 'bounty.seen',
    subjectId: 'listing-poll-1',
    payload: { channel: 'superteam', title: 'Some new bounty' },
  });
  assert.equal(hasSeenListing('superteam', 'listing-poll-1'), true);
  // Cross-channel collision protection: an event for sherlock with the
  // same id must NOT register as seen on superteam.
  recordEvent({
    kind: 'bounty.seen',
    subjectId: 'listing-only-on-sherlock',
    payload: { channel: 'sherlock', title: 'Audit' },
  });
  assert.equal(hasSeenListing('sherlock', 'listing-only-on-sherlock'), true);
  assert.equal(hasSeenListing('superteam', 'listing-only-on-sherlock'), false);
}));
