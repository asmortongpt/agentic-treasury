/**
 * Tests for the pure helpers in scripts/health-check.ts. Runs under
 * `node --experimental-strip-types --no-warnings --test`.
 *
 *   node --experimental-strip-types --no-warnings --test scripts/health-check.test.ts
 *
 * We test only the pure functions — launchctl-output parser, exit-status
 * decoder, log-staleness check, status aggregator, and the JSONL
 * truncator. The impure system probes (launchctl/fetch/osascript) are
 * covered by the smoke test invocation, not the unit suite.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  parseLaunchctlShow,
  decodeExitStatus,
  isLogFresh,
  aggregateStatus,
  truncateJsonlToLastN,
} from './health-check.ts';

// ---------------------------------------------------------------------------
// parseLaunchctlShow
// ---------------------------------------------------------------------------

test('parseLaunchctlShow extracts PID and LastExitStatus from running job', () => {
  // Real output captured from `launchctl list com.giggrabber.processor`
  // earlier today. PID 79239, LastExitStatus 65280 (= 255 << 8, the
  // silent crash we're building monitoring for).
  const sample = `{
    "StandardOutPath" = "/x/processor.log";
    "Label" = "com.giggrabber.processor";
    "OnDemand" = false;
    "LastExitStatus" = 65280;
    "PID" = 79239;
  };`;
  const parsed = parseLaunchctlShow(sample);
  assert.equal(parsed.pid, 79239);
  assert.equal(parsed.lastExitStatus, 65280);
});

test('parseLaunchctlShow handles job with no PID (not currently running)', () => {
  const sample = `{
    "Label" = "com.giggrabber.token-refresh";
    "LastExitStatus" = 0;
  };`;
  const parsed = parseLaunchctlShow(sample);
  assert.equal(parsed.pid, null);
  assert.equal(parsed.lastExitStatus, 0);
});

test('parseLaunchctlShow handles negative LastExitStatus (signal kill)', () => {
  // launchctl reports SIGTERM as -15 on some macOS versions.
  const sample = `{
    "Label" = "com.mortondigital.moneymaker";
    "PID" = 60140;
    "LastExitStatus" = -15;
  };`;
  const parsed = parseLaunchctlShow(sample);
  assert.equal(parsed.pid, 60140);
  assert.equal(parsed.lastExitStatus, -15);
});

test('parseLaunchctlShow returns nulls when fields absent', () => {
  const parsed = parseLaunchctlShow('total garbage, no fields');
  assert.equal(parsed.pid, null);
  assert.equal(parsed.lastExitStatus, null);
});

// ---------------------------------------------------------------------------
// decodeExitStatus
// ---------------------------------------------------------------------------

test('decodeExitStatus decodes the 65280 silent crash to exit 255', () => {
  // 65280 = 0xFF00, the raw waitpid status word for "exited with code 255".
  const d = decodeExitStatus(65280);
  assert.equal(d.code, 255);
  assert.equal(d.killed, false);
  assert.equal(d.signal, null);
});

test('decodeExitStatus decodes 0 as clean exit', () => {
  const d = decodeExitStatus(0);
  assert.deepEqual(d, { code: 0, killed: false, signal: null });
});

test('decodeExitStatus decodes negative status as signal kill', () => {
  const d = decodeExitStatus(-15);
  assert.equal(d.killed, true);
  assert.equal(d.signal, 15);
});

// ---------------------------------------------------------------------------
// isLogFresh
// ---------------------------------------------------------------------------

test('isLogFresh returns true for a log that is younger than the threshold', () => {
  const now = 1_700_000_000_000;
  const fiveMinAgo = now - 5 * 60_000;
  assert.equal(isLogFresh(fiveMinAgo, now, 30), true);
});

test('isLogFresh returns false for a log older than the threshold', () => {
  const now = 1_700_000_000_000;
  // 9 days old, mirroring the actual gap we want to catch.
  const nineDaysAgo = now - 9 * 24 * 60 * 60_000;
  assert.equal(isLogFresh(nineDaysAgo, now, 30), false);
});

test('isLogFresh returns false for a future mtime (clock skew safety)', () => {
  const now = 1_700_000_000_000;
  const future = now + 10 * 60_000;
  assert.equal(isLogFresh(future, now, 30), false);
});

// ---------------------------------------------------------------------------
// aggregateStatus
// ---------------------------------------------------------------------------

test('aggregateStatus: empty input is ok', () => {
  assert.equal(aggregateStatus([]), 'ok');
});

test('aggregateStatus: any fail dominates', () => {
  assert.equal(
    aggregateStatus([{ status: 'ok' }, { status: 'warn' }, { status: 'fail' }, { status: 'ok' }]),
    'fail',
  );
});

test('aggregateStatus: warn beats ok but not fail', () => {
  assert.equal(aggregateStatus([{ status: 'ok' }, { status: 'warn' }]), 'warn');
  assert.equal(aggregateStatus([{ status: 'ok' }, { status: 'ok' }]), 'ok');
});

// ---------------------------------------------------------------------------
// truncateJsonlToLastN
// ---------------------------------------------------------------------------

test('truncateJsonlToLastN keeps only the last N lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-check-test-'));
  const path = join(dir, 'hist.jsonl');
  const lines: string[] = [];
  for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ i }));
  writeFileSync(path, lines.join('\n') + '\n');

  const kept = truncateJsonlToLastN(path, 3);
  assert.equal(kept, 3);

  const remaining = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(remaining, [JSON.stringify({ i: 7 }), JSON.stringify({ i: 8 }), JSON.stringify({ i: 9 })]);
});

test('truncateJsonlToLastN is a no-op when file has <= N lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-check-test-'));
  const path = join(dir, 'small.jsonl');
  writeFileSync(path, '{"a":1}\n{"a":2}\n');
  const kept = truncateJsonlToLastN(path, 100);
  assert.equal(kept, 2);
  assert.equal(readFileSync(path, 'utf8'), '{"a":1}\n{"a":2}\n');
});

test('truncateJsonlToLastN returns 0 when file does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-check-test-'));
  const missing = join(dir, 'nope.jsonl');
  assert.equal(existsSync(missing), false);
  assert.equal(truncateJsonlToLastN(missing, 100), 0);
});
