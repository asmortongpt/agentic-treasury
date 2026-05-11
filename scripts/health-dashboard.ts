/**
 * Health dashboard — one-screen plaintext summary of recent
 * health-check runs.
 *
 *   node --experimental-strip-types --no-warnings scripts/health-dashboard.ts
 *
 * Reads ~/.agentic-treasury/health-history.jsonl (written by
 * health-check.ts), considers the last 24h, and prints:
 *
 *   - current overall state (from the most recent run)
 *   - per-target state, ok / fail counts, MTBF (mean time between
 *     failures), and time-to-detection for the most recent failure.
 *
 * Time-to-detection here is the gap between when the upstream signal
 * went stale (best estimated as the previous ok run's timestamp) and
 * when we caught it. That number is the whole reason this layer
 * exists: in the 9-day silent-processor incident it was unbounded.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HealthRunSummary, CheckResult, Status } from './health-check.ts';

const HISTORY_FILE = join(homedir(), '.agentic-treasury', 'health-history.jsonl');
const WINDOW_HOURS = 24;

function loadHistory(): HealthRunSummary[] {
  if (!existsSync(HISTORY_FILE)) return [];
  const raw = readFileSync(HISTORY_FILE, 'utf8');
  const out: HealthRunSummary[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as HealthRunSummary);
    } catch {
      // Skip corrupt lines silently — one bad write shouldn't break
      // the dashboard.
    }
  }
  return out;
}

function statusGlyph(s: Status): string {
  if (s === 'ok') return 'OK  ';
  if (s === 'warn') return 'WARN';
  return 'FAIL';
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

interface PerTarget {
  target: string;
  kind: string;
  totalRuns: number;
  okRuns: number;
  warnRuns: number;
  failRuns: number;
  currentStatus: Status;
  currentMessage: string;
  lastFailureISO: string | null;
  lastOkBeforeFailureISO: string | null;
  // MTBF in minutes (across the window). Null if <2 failures.
  mtbfMinutes: number | null;
  // Time-to-detection in minutes for the most recent failure.
  // = (firstFailRunISO - lastOkRunISO).
  detectionLagMinutes: number | null;
}

function rollupPerTarget(runs: HealthRunSummary[]): PerTarget[] {
  const cutoff = Date.now() - WINDOW_HOURS * 3600 * 1000;
  const recent = runs.filter(r => new Date(r.timeISO).getTime() >= cutoff);

  // Collect history per (kind, target).
  const byTarget = new Map<string, { kind: string; target: string; entries: Array<{ time: number; status: Status; message: string }> }>();

  for (const run of recent) {
    const t = new Date(run.timeISO).getTime();
    for (const c of run.checks) {
      const key = `${c.kind}::${c.target}`;
      let bucket = byTarget.get(key);
      if (!bucket) {
        bucket = { kind: c.kind, target: c.target, entries: [] };
        byTarget.set(key, bucket);
      }
      bucket.entries.push({ time: t, status: c.status, message: c.message });
    }
  }

  const out: PerTarget[] = [];
  for (const { kind, target, entries } of byTarget.values()) {
    entries.sort((a, b) => a.time - b.time);
    let okRuns = 0;
    let warnRuns = 0;
    let failRuns = 0;
    const failTimes: number[] = [];
    let lastOkBeforeFailureMs: number | null = null;
    let mostRecentFailMs: number | null = null;
    let priorOkMs: number | null = null;

    for (const e of entries) {
      if (e.status === 'ok') {
        okRuns++;
        priorOkMs = e.time;
      } else if (e.status === 'warn') {
        warnRuns++;
      } else {
        failRuns++;
        failTimes.push(e.time);
        // If this is the *first* fail in a chain (previous was ok),
        // record the detection lag from the prior ok run.
        if (mostRecentFailMs === null || (mostRecentFailMs !== null && mostRecentFailMs < priorOkMs!)) {
          // priorOkMs may be null if we never saw an ok before this fail.
          lastOkBeforeFailureMs = priorOkMs;
        }
        mostRecentFailMs = e.time;
      }
    }

    // MTBF: mean gap between consecutive failures (minutes).
    let mtbfMinutes: number | null = null;
    if (failTimes.length >= 2) {
      let sum = 0;
      for (let i = 1; i < failTimes.length; i++) sum += (failTimes[i]! - failTimes[i - 1]!);
      mtbfMinutes = sum / (failTimes.length - 1) / 60_000;
    }

    let detectionLagMinutes: number | null = null;
    if (mostRecentFailMs !== null && lastOkBeforeFailureMs !== null) {
      detectionLagMinutes = (mostRecentFailMs - lastOkBeforeFailureMs) / 60_000;
    }

    const last = entries[entries.length - 1]!;
    out.push({
      kind,
      target,
      totalRuns: entries.length,
      okRuns,
      warnRuns,
      failRuns,
      currentStatus: last.status,
      currentMessage: last.message,
      lastFailureISO: mostRecentFailMs === null ? null : new Date(mostRecentFailMs).toISOString(),
      lastOkBeforeFailureISO: lastOkBeforeFailureMs === null ? null : new Date(lastOkBeforeFailureMs).toISOString(),
      mtbfMinutes,
      detectionLagMinutes,
    });
  }

  // Sort: fails first, then warns, then ok; alphabetical within rank.
  const rank = { fail: 0, warn: 1, ok: 2 } as const;
  out.sort((a, b) => {
    const r = rank[a.currentStatus] - rank[b.currentStatus];
    if (r !== 0) return r;
    return a.target.localeCompare(b.target);
  });
  return out;
}

function main(): void {
  const runs = loadHistory();
  if (runs.length === 0) {
    process.stdout.write(`(no history at ${HISTORY_FILE} yet — run scripts/health-check.ts at least once)\n`);
    return;
  }

  const latest = runs[runs.length - 1]!;
  const rollup = rollupPerTarget(runs);

  const out: string[] = [];
  out.push('='.repeat(78));
  out.push(` agentic-treasury  HEALTH DASHBOARD`);
  out.push(` history file:  ${HISTORY_FILE}`);
  out.push(` total runs:    ${runs.length}  (window: last ${WINDOW_HOURS}h)`);
  out.push(` last run:      ${latest.timeISO}   overall: ${statusGlyph(latest.overall)}    (ok:${latest.ok} warn:${latest.warn} fail:${latest.fail})`);
  out.push('='.repeat(78));
  out.push('');
  out.push(` ${pad('STATUS', 5)} ${pad('KIND', 22)} ${pad('TARGET', 38)} ${pad('OK/W/F', 10)} ${pad('MTBF', 12)} ${pad('LAG', 10)}`);
  out.push(` ${'-'.repeat(5)} ${'-'.repeat(22)} ${'-'.repeat(38)} ${'-'.repeat(10)} ${'-'.repeat(12)} ${'-'.repeat(10)}`);

  for (const r of rollup) {
    const okWF = `${r.okRuns}/${r.warnRuns}/${r.failRuns}`;
    const mtbf = r.mtbfMinutes === null ? '-' : `${r.mtbfMinutes.toFixed(0)}m`;
    const lag = r.detectionLagMinutes === null ? '-' : `${r.detectionLagMinutes.toFixed(0)}m`;
    out.push(` ${pad(statusGlyph(r.currentStatus), 5)} ${pad(r.kind, 22)} ${pad(r.target, 38)} ${pad(okWF, 10)} ${pad(mtbf, 12)} ${pad(lag, 10)}`);
  }

  out.push('');
  out.push(' LATEST FAILURES (most recent run):');
  const failed: CheckResult[] = latest.checks.filter(c => c.status === 'fail');
  if (failed.length === 0) {
    out.push('   (none)');
  } else {
    for (const c of failed) {
      out.push(`   - [${c.kind}] ${c.target}`);
      out.push(`       ${c.message}`);
    }
  }

  out.push('');
  out.push(' Notes:');
  out.push('   OK/W/F  = ok / warn / fail counts in window');
  out.push('   MTBF    = mean time between consecutive failures in window');
  out.push('   LAG     = detection lag for the most recent failure (ok→fail gap)');
  out.push('');
  process.stdout.write(out.join('\n') + '\n');
}

main();
