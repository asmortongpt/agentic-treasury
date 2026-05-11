/**
 * Public API for the local-first memory layer.
 *
 * Three primitives:
 *   - submissions  — bounties/gigs we've actually entered. Updated as
 *     the outcome changes (pending → won → paid, or → lost/rejected).
 *   - events       — append-only structured log. Used for "have we seen
 *     this listing before?", "what happened in the last hour?", etc.
 *   - lessons      — short one-line strings the agent can re-read on
 *     subsequent cycles so it doesn't repeat the same mistakes.
 *
 * All functions are sync — node:sqlite is sync, and the workloads here
 * are small (single-digit ms per op) so there's no reason to layer
 * Promise wrappers on top.
 *
 * Persistence is local-first: a single SQLite file under
 * `~/.agentic-treasury/memory.db`. Nothing in this module touches the
 * network.
 *
 * Lazy connection: callers don't have to manage a DB handle. The first
 * function that needs the DB opens it (and migrates the schema), then
 * reuses it for subsequent calls in the same process. Tests reset by
 * calling `resetMemoryForTests()` after pointing
 * `AGENTIC_TREASURY_MEMORY_DB` at a fresh tempdir.
 */

import { openDatabase, closeDatabase, resolveDbPath, type DB } from './db.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubmissionStatus =
  | 'pending'
  | 'won'
  | 'lost'
  | 'paid'
  | 'rejected'
  | 'unknown';

export interface Submission {
  id: string;
  platform: string;
  listingId: string;
  listingTitle: string | null;
  submittedAt: Date;
  status: SubmissionStatus;
  rewardUsd: number | null;
  paidAt: Date | null;
  metadata: Record<string, unknown> | null;
}

export interface EventRecord {
  id: number;
  ts: Date;
  kind: string;
  subjectId: string | null;
  payload: Record<string, unknown> | null;
}

export interface Lesson {
  id: number;
  category: string;
  summary: string;
  evidence: Record<string, unknown> | null;
  createdAt: Date;
  appliedCount: number;
}

export interface RecordSubmissionOpts {
  id: string;
  platform: string;
  listingId: string;
  listingTitle?: string;
  submittedAt?: Date;
  status: SubmissionStatus;
  rewardUsd?: number;
  metadata?: Record<string, unknown>;
}

export interface RecordEventOpts {
  kind: string;
  subjectId?: string;
  payload?: Record<string, unknown>;
  ts?: Date;
}

export interface RecordLessonOpts {
  category: string;
  summary: string;
  evidence?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal: lazy singleton DB handle, keyed by path so tests that switch
// the AGENTIC_TREASURY_MEMORY_DB env var between cases get a fresh
// connection rather than a stale handle to the previous file.
// ---------------------------------------------------------------------------

let cachedDb: DB | null = null;
let cachedPath: string | null = null;

function getDb(): DB {
  const path = resolveDbPath();
  if (cachedDb && cachedPath === path) return cachedDb;
  if (cachedDb && cachedPath !== path) {
    closeDatabase(cachedDb);
    cachedDb = null;
  }
  cachedDb = openDatabase(path);
  cachedPath = path;
  return cachedDb;
}

/**
 * Test hook — close any open DB handle so the next call to a memory
 * function reopens against whatever path is currently configured. Not
 * intended for production code paths.
 */
export function resetMemoryForTests(): void {
  if (cachedDb) {
    closeDatabase(cachedDb);
    cachedDb = null;
    cachedPath = null;
  }
}

// ---------------------------------------------------------------------------
// Row mappers (sqlite always hands back string|number|bigint|null|Buffer,
// so we narrow to the project's domain types here).
// ---------------------------------------------------------------------------

interface SubmissionRow {
  id: string;
  platform: string;
  listing_id: string;
  listing_title: string | null;
  submitted_at: number;
  status: string;
  reward_usd: number | null;
  paid_at: number | null;
  metadata_json: string | null;
}

interface EventRow {
  id: number;
  ts: number;
  kind: string;
  subject_id: string | null;
  payload_json: string | null;
}

interface LessonRow {
  id: number;
  category: string;
  summary: string;
  evidence_json: string | null;
  created_at: number;
  applied_count: number;
}

function parseJsonOrNull<T = Record<string, unknown>>(s: string | null): T | null {
  if (s === null || s === '') return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function mapSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    platform: row.platform,
    listingId: row.listing_id,
    listingTitle: row.listing_title,
    submittedAt: new Date(row.submitted_at),
    status: row.status as SubmissionStatus,
    rewardUsd: row.reward_usd,
    paidAt: row.paid_at !== null ? new Date(row.paid_at) : null,
    metadata: parseJsonOrNull(row.metadata_json),
  };
}

function mapEvent(row: EventRow): EventRecord {
  return {
    id: row.id,
    ts: new Date(row.ts),
    kind: row.kind,
    subjectId: row.subject_id,
    payload: parseJsonOrNull(row.payload_json),
  };
}

function mapLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    category: row.category,
    summary: row.summary,
    evidence: parseJsonOrNull(row.evidence_json),
    createdAt: new Date(row.created_at),
    appliedCount: row.applied_count,
  };
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

/**
 * Insert a submission record. The id is the primary key — re-inserting
 * with the same id is treated as an upsert (we replace, because the
 * later call has fresher data by definition).
 */
export function recordSubmission(opts: RecordSubmissionOpts): void {
  const db = getDb();
  const submittedAt = (opts.submittedAt ?? new Date()).getTime();
  const stmt = db.prepare(`
    INSERT INTO submissions
      (id, platform, listing_id, listing_title, submitted_at, status, reward_usd, paid_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO UPDATE SET
      platform = excluded.platform,
      listing_id = excluded.listing_id,
      listing_title = COALESCE(excluded.listing_title, submissions.listing_title),
      status = excluded.status,
      reward_usd = COALESCE(excluded.reward_usd, submissions.reward_usd),
      metadata_json = COALESCE(excluded.metadata_json, submissions.metadata_json)
  `);
  stmt.run(
    opts.id,
    opts.platform,
    opts.listingId,
    opts.listingTitle ?? null,
    submittedAt,
    opts.status,
    opts.rewardUsd ?? null,
    opts.metadata ? JSON.stringify(opts.metadata) : null,
  );
}

/**
 * Update only the mutable outcome fields of a submission. `id` must
 * already exist; throws if not (callers should `recordSubmission` first).
 */
export function updateSubmissionStatus(
  id: string,
  status: SubmissionStatus,
  rewardUsd?: number,
  paidAt?: Date,
): void {
  const db = getDb();
  const existing = getSubmission(id);
  if (existing === null) {
    throw new Error(`updateSubmissionStatus: no submission with id=${id}`);
  }
  const stmt = db.prepare(`
    UPDATE submissions
       SET status = ?,
           reward_usd = COALESCE(?, reward_usd),
           paid_at = COALESCE(?, paid_at)
     WHERE id = ?
  `);
  stmt.run(
    status,
    rewardUsd ?? null,
    paidAt ? paidAt.getTime() : null,
    id,
  );
}

export function getSubmission(id: string): Submission | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
  return row ? mapSubmission(row) : null;
}

export interface ListSubmissionsFilter {
  platform?: string;
  status?: SubmissionStatus;
}

export function listSubmissions(filter: ListSubmissionsFilter = {}): Submission[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: Array<string> = [];
  if (filter.platform !== undefined) {
    clauses.push('platform = ?');
    params.push(filter.platform);
  }
  if (filter.status !== undefined) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT * FROM submissions ${where} ORDER BY submitted_at DESC`)
    .all(...params) as unknown as SubmissionRow[];
  return rows.map(mapSubmission);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function recordEvent(opts: RecordEventOpts): void {
  const db = getDb();
  const ts = (opts.ts ?? new Date()).getTime();
  db.prepare(`
    INSERT INTO events (ts, kind, subject_id, payload_json)
    VALUES (?, ?, ?, ?)
  `).run(
    ts,
    opts.kind,
    opts.subjectId ?? null,
    opts.payload ? JSON.stringify(opts.payload) : null,
  );
}

export interface RecentEventsOpts {
  kind?: string;
  sinceMs?: number;   // epoch ms; events with ts >= sinceMs
  limit?: number;     // default 100
}

export function recentEvents(opts: RecentEventsOpts = {}): EventRecord[] {
  const db = getDb();
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.kind !== undefined) {
    clauses.push('kind = ?');
    params.push(opts.kind);
  }
  if (opts.sinceMs !== undefined) {
    clauses.push('ts >= ?');
    params.push(opts.sinceMs);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 10_000));
  const rows = db
    .prepare(`SELECT * FROM events ${where} ORDER BY ts DESC LIMIT ?`)
    .all(...params, limit) as unknown as EventRow[];
  return rows.map(mapEvent);
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

export function recordLesson(opts: RecordLessonOpts): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO lessons (category, summary, evidence_json, created_at, applied_count)
    VALUES (?, ?, ?, ?, 0)
  `).run(
    opts.category,
    opts.summary,
    opts.evidence ? JSON.stringify(opts.evidence) : null,
    Date.now(),
  );
}

export function getLessons(category: string, limit: number = 50): Lesson[] {
  const db = getDb();
  const rows = db
    .prepare(`
      SELECT * FROM lessons
       WHERE category = ?
       ORDER BY created_at DESC
       LIMIT ?
    `)
    .all(category, Math.max(1, Math.min(limit, 10_000))) as unknown as LessonRow[];
  return rows.map(mapLesson);
}

export function markLessonApplied(id: number): void {
  const db = getDb();
  db.prepare('UPDATE lessons SET applied_count = applied_count + 1 WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// De-dupe helpers
// ---------------------------------------------------------------------------

/**
 * True if we have ever seen a listing on this platform — either as a
 * recorded submission OR as a `bounty.seen` event. Both signals matter:
 * `recordSubmission` covers "we entered it", `bounty.seen` covers "we
 * looked at it but haven't entered it yet" (which the poller logs).
 */
export function hasSeenListing(platform: string, listingId: string): boolean {
  const db = getDb();
  const subRow = db
    .prepare('SELECT 1 FROM submissions WHERE platform = ? AND listing_id = ? LIMIT 1')
    .get(platform, listingId);
  if (subRow !== undefined) return true;

  // The poller writes bounty.seen events with subjectId = listing id and
  // payload.channel = platform. Match on both so we don't false-positive
  // a sherlock id that happens to collide with a superteam id.
  const evtRow = db
    .prepare(`
      SELECT 1 FROM events
       WHERE kind = 'bounty.seen'
         AND subject_id = ?
         AND payload_json LIKE ?
       LIMIT 1
    `)
    .get(listingId, `%"channel":"${platform}"%`);
  return evtRow !== undefined;
}
