/**
 * SQLite connector for the local-first memory layer.
 *
 * Uses `node:sqlite` from the stdlib — no npm dependency. Requires Node
 * 22+ (available as of v22.5.0; the agentic-treasury package.json
 * already pins `node >= 22`).
 *
 * Default database path: `~/.agentic-treasury/memory.db`. Override with
 * the `AGENTIC_TREASURY_MEMORY_DB` env var (used by tests with a tempdir
 * so they don't share state).
 *
 * The schema is intentionally tiny: three tables (submissions, events,
 * lessons) keyed for the common query paths. Migrations are idempotent
 * `CREATE IF NOT EXISTS` statements — there is no migration framework
 * because there isn't enough schema to justify one.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type DB = DatabaseSync;

const DEFAULT_DB_PATH = join(homedir(), '.agentic-treasury', 'memory.db');

/**
 * Resolve the database path. Honors `AGENTIC_TREASURY_MEMORY_DB` so
 * tests can point each run at its own tempdir.
 */
export function resolveDbPath(): string {
  const override = process.env['AGENTIC_TREASURY_MEMORY_DB'];
  return override && override.length > 0 ? override : DEFAULT_DB_PATH;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  listing_title TEXT,
  submitted_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  reward_usd REAL,
  paid_at INTEGER,
  metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  subject_id TEXT,
  payload_json TEXT
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT,
  created_at INTEGER NOT NULL,
  applied_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);
CREATE INDEX IF NOT EXISTS idx_lessons_category ON lessons(category);
CREATE INDEX IF NOT EXISTS idx_submissions_platform_status ON submissions(platform, status);
CREATE INDEX IF NOT EXISTS idx_submissions_listing ON submissions(platform, listing_id);
`;

/**
 * Open the database (creating parent dir if needed), apply migrations,
 * and return a connected DB handle. Idempotent — calling twice on the
 * same path is safe.
 */
export function openDatabase(path: string = resolveDbPath()): DB {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path);
  // Run all migration statements inside a single transaction so a
  // partial failure (e.g. disk full mid-migration) doesn't leave the
  // schema half-applied.
  db.exec('BEGIN');
  try {
    db.exec(SCHEMA);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  // Reasonable pragmas for a local single-writer workload.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

/**
 * Close the database. Safe to call multiple times.
 */
export function closeDatabase(db: DB): void {
  try {
    db.close();
  } catch {
    // Already closed — that's fine.
  }
}
