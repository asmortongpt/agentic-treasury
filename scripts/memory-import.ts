/**
 * One-shot backfill for the local-first memory layer.
 *
 *   node --experimental-strip-types --no-warnings scripts/memory-import.ts
 *
 * Reads the two ambient sources of existing-but-uncentralized state we
 * already have:
 *
 *   1. `~/.agentic-treasury/state.json` — the poller's `seen` map. Every
 *      listing id we've ever surfaced through poll-bounties is in here,
 *      keyed by channel, with the first-seen ISO timestamp as the value.
 *      We rewrite each as a `bounty.seen` event in the memory db,
 *      preserving the original timestamp.
 *
 *   2. `SUPERTEAM_SUB_*` env vars — Doppler holds the submission IDs we
 *      created on Superteam (one per article). Each becomes a row in
 *      `submissions` with `platform='superteam'` and `status='pending'`,
 *      using the env-var suffix as the human label until we can replace
 *      it with the real listing title from the API.
 *
 * Idempotent: re-running does not duplicate rows. We dedupe events by
 * (kind, subject_id, ts) and submissions by their primary-key id.
 *
 * Output: a single JSON object on stdout summarizing what we inserted vs.
 * skipped, plus a short human-readable line on stderr.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  recordEvent,
  recordSubmission,
  getSubmission,
  recentEvents,
} from '../src/memory/index.ts';

interface PollerState {
  seen?: Record<string, Record<string, string>>;
  lastRun?: string;
}

interface ImportSummary {
  events: { inserted: number; skipped: number };
  submissions: { inserted: number; skipped: number };
  notes: string[];
}

const STATE_FILE = join(homedir(), '.agentic-treasury', 'state.json');

// ---------------------------------------------------------------------------
// Poller state → bounty.seen events
// ---------------------------------------------------------------------------

function importPollerState(summary: ImportSummary): void {
  if (!existsSync(STATE_FILE)) {
    summary.notes.push(`state.json not found at ${STATE_FILE}; skipping poller backfill`);
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(STATE_FILE, 'utf8');
  } catch (err) {
    summary.notes.push(`could not read state.json: ${String(err).slice(0, 120)}`);
    return;
  }
  let state: PollerState;
  try {
    state = JSON.parse(raw) as PollerState;
  } catch (err) {
    summary.notes.push(`state.json is not valid JSON: ${String(err).slice(0, 120)}`);
    return;
  }
  const seen = state.seen ?? {};

  // To dedupe without making the API surface ugly, we pull the whole
  // recent-events list once and build an in-memory set keyed by
  // `${kind}|${subjectId}|${ts}`. The poller-state size is bounded by
  // how many bounties have ever appeared (currently 1, realistically
  // hundreds over time), so this is fine.
  const existingKeys = new Set<string>();
  for (const evt of recentEvents({ kind: 'bounty.seen', limit: 10_000 })) {
    if (evt.subjectId !== null) {
      existingKeys.add(`bounty.seen|${evt.subjectId}|${evt.ts.getTime()}`);
    }
  }

  for (const [channel, ids] of Object.entries(seen)) {
    for (const [listingId, isoTs] of Object.entries(ids)) {
      const ts = new Date(isoTs);
      const tsMs = Number.isFinite(ts.getTime()) ? ts.getTime() : Date.now();
      const key = `bounty.seen|${listingId}|${tsMs}`;
      if (existingKeys.has(key)) {
        summary.events.skipped += 1;
        continue;
      }
      recordEvent({
        kind: 'bounty.seen',
        subjectId: listingId,
        payload: { channel, source: 'memory-import.poller-state' },
        ts: new Date(tsMs),
      });
      existingKeys.add(key);
      summary.events.inserted += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Doppler SUPERTEAM_SUB_* env vars → submissions rows
// ---------------------------------------------------------------------------

/**
 * Best-effort title derivation from the env var suffix. We have nothing
 * better at backfill time — the per-submission GET endpoint on
 * Superteam currently returns 404 (documented in health-check.ts), so
 * we can't fetch the real listing title here without burning the
 * SUPERTEAM_AGENT_API_KEY for no benefit. The poller will pick up the
 * real title on its next pass when the listing reappears on the live
 * board.
 */
function suffixToLabel(suffix: string): string {
  return suffix
    .split('_')
    .map(part => part.charAt(0) + part.slice(1).toLowerCase())
    .join(' ');
}

function importSuperteamSubmissions(summary: ImportSummary): void {
  const PREFIX = 'SUPERTEAM_SUB_';
  for (const [envName, value] of Object.entries(process.env)) {
    if (!envName.startsWith(PREFIX)) continue;
    if (value === undefined || value.trim() === '') continue;
    const subId = value.trim();
    if (getSubmission(subId) !== null) {
      summary.submissions.skipped += 1;
      continue;
    }
    const suffix = envName.slice(PREFIX.length);
    recordSubmission({
      id: subId,
      platform: 'superteam',
      // We don't know the true listing id from Doppler alone — record
      // the submission id as a placeholder for the listing_id slot so
      // the row is still queryable. A future enricher can replace it
      // when we wire up the live listing fetch.
      listingId: subId,
      listingTitle: suffixToLabel(suffix),
      status: 'pending',
      metadata: { dopplerEnv: envName, source: 'memory-import.doppler' },
    });
    summary.submissions.inserted += 1;
  }
  if (summary.submissions.inserted === 0 && summary.submissions.skipped === 0) {
    summary.notes.push('no SUPERTEAM_SUB_* env vars present; run under `doppler run --` to backfill');
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const summary: ImportSummary = {
    events: { inserted: 0, skipped: 0 },
    submissions: { inserted: 0, skipped: 0 },
    notes: [],
  };
  importPollerState(summary);
  importSuperteamSubmissions(summary);

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  process.stderr.write(
    `[memory-import] events: +${summary.events.inserted} new / ${summary.events.skipped} dup` +
    ` | submissions: +${summary.submissions.inserted} new / ${summary.submissions.skipped} dup\n`,
  );
}

main();
