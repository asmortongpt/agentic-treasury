/**
 * Health check — one-shot probe of the autonomous earning loop.
 *
 *   node --experimental-strip-types --no-warnings scripts/health-check.ts
 *
 * Background. On or around 2026-05-01 the `com.giggrabber.processor`
 * launchd job exited with code 255 and stayed silent for 9 days. We
 * only noticed by running `launchctl list | grep giggrabber` by hand.
 * The autonomous earning loop was dead and there was no signal.
 *
 * This script closes that gap. It's deliberately thin:
 *   - Reads scripts/config/watched.json for what to watch.
 *   - For each launchd job: probe `launchctl list <label>` for PID +
 *     last exit status; check the matching log file's mtime for
 *     staleness.
 *   - For each HTTP probe: GET with a 5s timeout, expect 2xx.
 *   - For each Superteam submission id in Doppler env: GET
 *     /api/agents/submissions/<id> and surface isWinner / isPaid.
 *
 * Exits 0 if every check is ok, 1 if any failed. Emits a single JSON
 * summary object to stdout, suitable for log scraping. Appends the
 * same object as a JSON line to ~/.agentic-treasury/health-history.jsonl
 * (capped at the last 5000 lines).
 *
 * No external dependencies. No network calls except those declared in
 * the config. No data leaves this machine.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Status = 'ok' | 'warn' | 'fail';

export interface LaunchdJobConfig {
  label: string;
  logPath: string;
  maxStaleMinutes: number;
}

export interface HttpProbeConfig {
  url: string;
  name?: string;
  timeoutMs?: number;
}

export interface WatchedConfig {
  launchdJobs: LaunchdJobConfig[];
  httpProbes: HttpProbeConfig[];
  superteamSubmissions: string[];
}

export interface CheckResult {
  kind: 'launchd' | 'log-staleness' | 'http' | 'superteam-submission';
  target: string;
  status: Status;
  message: string;
  detail?: Record<string, unknown>;
}

export interface HealthRunSummary {
  timeISO: string;
  overall: Status;
  ok: number;
  warn: number;
  fail: number;
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse the output of `launchctl list <label>`. The single-label form
 * returns a plist-style dict like:
 *
 *   {
 *     "PID" = 79239;
 *     "LastExitStatus" = 65280;
 *     "Label" = "com.giggrabber.processor";
 *     ...
 *   };
 *
 * Returns { pid, lastExitStatus } with nulls when absent. LastExitStatus
 * is the raw waitpid() status: shift right 8 bits to get the user-visible
 * exit code (so 65280 >> 8 = 255 = the silent processor crash).
 */
export function parseLaunchctlShow(output: string): { pid: number | null; lastExitStatus: number | null } {
  const pidMatch = output.match(/"PID"\s*=\s*(\d+);/);
  const exitMatch = output.match(/"LastExitStatus"\s*=\s*(-?\d+);/);
  return {
    pid: pidMatch && pidMatch[1] !== undefined ? Number(pidMatch[1]) : null,
    lastExitStatus: exitMatch && exitMatch[1] !== undefined ? Number(exitMatch[1]) : null,
  };
}

/**
 * Decode a raw launchd LastExitStatus into a human-readable exit code.
 * launchd reports the waitpid status word: low byte is signal (if killed),
 * high byte is exit code (if exited normally). 0 = clean. Negative values
 * indicate signal kills on some launchd versions (e.g. -15 = SIGTERM).
 */
export function decodeExitStatus(raw: number): { code: number; killed: boolean; signal: number | null } {
  if (raw === 0) return { code: 0, killed: false, signal: null };
  if (raw < 0) return { code: raw, killed: true, signal: -raw };
  const signal = raw & 0x7f;
  if (signal !== 0 && signal !== 0x7f) {
    return { code: raw, killed: true, signal };
  }
  return { code: (raw >> 8) & 0xff, killed: false, signal: null };
}

/**
 * Returns true if the file's mtime is within `maxStaleMinutes` of `now`.
 * Returns false if the file doesn't exist (caller decides whether that's
 * a fail or warn).
 */
export function isLogFresh(mtimeMs: number, nowMs: number, maxStaleMinutes: number): boolean {
  const ageMs = nowMs - mtimeMs;
  return ageMs >= 0 && ageMs <= maxStaleMinutes * 60 * 1000;
}

/**
 * Aggregate per-check statuses into one overall status. Any fail → fail,
 * else any warn → warn, else ok. Empty list is ok by definition.
 */
export function aggregateStatus(results: ReadonlyArray<{ status: Status }>): Status {
  let worst: Status = 'ok';
  for (const r of results) {
    if (r.status === 'fail') return 'fail';
    if (r.status === 'warn') worst = 'warn';
  }
  return worst;
}

/**
 * Truncate a JSONL history file to the last N lines, in place. Returns
 * the number of lines retained. No-op if the file has <= N lines.
 */
export function truncateJsonlToLastN(path: string, n: number): number {
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (lines.length <= n) return lines.length;
  const kept = lines.slice(lines.length - n);
  writeFileSync(path, kept.join('\n') + '\n');
  return kept.length;
}

// ---------------------------------------------------------------------------
// Checks (impure — touch the system)
// ---------------------------------------------------------------------------

function checkLaunchdJob(job: LaunchdJobConfig, nowMs: number): CheckResult[] {
  const results: CheckResult[] = [];

  // 1) launchctl list <label>
  let listOutput = '';
  try {
    listOutput = execFileSync('/bin/launchctl', ['list', job.label], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    results.push({
      kind: 'launchd',
      target: job.label,
      status: 'fail',
      message: `launchctl list ${job.label} failed — job not loaded`,
      detail: { error: String(err).slice(0, 200) },
    });
    return results; // Without the job loaded, log mtime check is meaningless.
  }

  const { pid, lastExitStatus } = parseLaunchctlShow(listOutput);
  const decoded = lastExitStatus === null ? null : decodeExitStatus(lastExitStatus);

  if (pid === null && decoded && decoded.code !== 0) {
    results.push({
      kind: 'launchd',
      target: job.label,
      status: 'fail',
      message: `not running; last exit ${decoded.code}${decoded.killed ? ` (signal ${decoded.signal})` : ''}`,
      detail: { pid, lastExitStatus, decodedCode: decoded.code, killed: decoded.killed, signal: decoded.signal },
    });
  } else if (pid === null) {
    // No PID and clean (or unknown) exit — treat as warn for periodic
    // jobs that genuinely sit idle between firings (e.g. token-refresh).
    results.push({
      kind: 'launchd',
      target: job.label,
      status: 'warn',
      message: 'loaded but not currently running (exit status was clean)',
      detail: { pid, lastExitStatus, decodedCode: decoded?.code ?? null },
    });
  } else {
    results.push({
      kind: 'launchd',
      target: job.label,
      status: 'ok',
      message: `running (PID ${pid})`,
      detail: { pid, lastExitStatus, decodedCode: decoded?.code ?? 0 },
    });
  }

  // 2) Log file mtime staleness — independent of run state, because a
  // process can "be alive" while doing nothing (MoneyMaker pipeline
  // sleeps 6h when kill switch trips; that looked alive but did no work).
  if (!existsSync(job.logPath)) {
    results.push({
      kind: 'log-staleness',
      target: job.logPath,
      status: 'fail',
      message: `log file missing`,
      detail: { logPath: job.logPath },
    });
  } else {
    const mtime = statSync(job.logPath).mtimeMs;
    const ageMin = (nowMs - mtime) / 60000;
    if (isLogFresh(mtime, nowMs, job.maxStaleMinutes)) {
      results.push({
        kind: 'log-staleness',
        target: job.logPath,
        status: 'ok',
        message: `log fresh (${ageMin.toFixed(1)} min old, threshold ${job.maxStaleMinutes})`,
        detail: { ageMinutes: Number(ageMin.toFixed(2)), thresholdMinutes: job.maxStaleMinutes },
      });
    } else {
      results.push({
        kind: 'log-staleness',
        target: job.logPath,
        status: 'fail',
        message: `log stale: ${ageMin.toFixed(1)} min old (threshold ${job.maxStaleMinutes})`,
        detail: { ageMinutes: Number(ageMin.toFixed(2)), thresholdMinutes: job.maxStaleMinutes },
      });
    }
  }

  return results;
}

async function checkHttpProbe(probe: HttpProbeConfig): Promise<CheckResult> {
  const timeoutMs = probe.timeoutMs ?? 5000;
  const name = probe.name ?? probe.url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(probe.url, { signal: controller.signal });
    if (res.ok) {
      return { kind: 'http', target: name, status: 'ok', message: `HTTP ${res.status}`, detail: { url: probe.url, status: res.status } };
    }
    return { kind: 'http', target: name, status: 'fail', message: `HTTP ${res.status}`, detail: { url: probe.url, status: res.status } };
  } catch (err) {
    return { kind: 'http', target: name, status: 'fail', message: `request failed: ${String(err).slice(0, 120)}`, detail: { url: probe.url } };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSuperteamSubmission(envName: string): Promise<CheckResult> {
  const subId = process.env[envName];
  if (!subId) {
    return {
      kind: 'superteam-submission',
      target: envName,
      status: 'warn',
      message: `env var ${envName} not set (run under doppler run -- ...)`,
    };
  }
  return checkSuperteamSubmissionById(subId, envName);
}

/**
 * Same probe as `checkSuperteamSubmission`, but takes a resolved
 * submission id directly. Used when we already have the id from the
 * memory db rather than from a Doppler env var.
 */
async function checkSuperteamSubmissionById(subId: string, label: string): Promise<CheckResult> {
  const apiKey = process.env['SUPERTEAM_AGENT_API_KEY'];
  if (!apiKey) {
    return {
      kind: 'superteam-submission',
      target: label,
      status: 'warn',
      message: 'SUPERTEAM_AGENT_API_KEY missing',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://superteam.fun/api/agents/submissions/${subId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      // 404 means Superteam has no per-submission GET endpoint at the
      // expected path. The IDs in Doppler are real (we created them),
      // so this is "API not available" rather than a true failure.
      // Surface as warn so the operator knows but the dashboard isn't
      // dominated by false fails. Anything else (401/403/5xx) is real.
      const status: Status = res.status === 404 ? 'warn' : 'fail';
      return {
        kind: 'superteam-submission',
        target: label,
        status,
        message: `HTTP ${res.status} fetching submission ${subId}${res.status === 404 ? ' (per-submission endpoint not available)' : ''}`,
        detail: { subId, httpStatus: res.status },
      };
    }
    const body = (await res.json()) as {
      id: string; isWinner?: boolean; isPaid?: boolean; status?: string; rewardInUSD?: number;
      listing?: { title?: string; slug?: string };
    };
    // Treat newly-won or newly-paid as an attention event (warn). A
    // win/payment isn't a *failure*, but the operator should hear about
    // it the same way they'd hear about a crash.
    if (body.isPaid) {
      return {
        kind: 'superteam-submission',
        target: label,
        status: 'warn',
        message: `PAID — ${body.listing?.title ?? subId}${body.rewardInUSD ? ` ($${body.rewardInUSD})` : ''}`,
        detail: { subId, isWinner: body.isWinner, isPaid: body.isPaid, rewardUSD: body.rewardInUSD, listingSlug: body.listing?.slug },
      };
    }
    if (body.isWinner) {
      return {
        kind: 'superteam-submission',
        target: label,
        status: 'warn',
        message: `WINNER — ${body.listing?.title ?? subId}`,
        detail: { subId, isWinner: body.isWinner, isPaid: body.isPaid, listingSlug: body.listing?.slug },
      };
    }
    return {
      kind: 'superteam-submission',
      target: label,
      status: 'ok',
      message: `pending — ${body.listing?.title ?? subId}`,
      detail: { subId, isWinner: body.isWinner ?? false, isPaid: body.isPaid ?? false, listingSlug: body.listing?.slug },
    };
  } catch (err) {
    return {
      kind: 'superteam-submission',
      target: label,
      status: 'fail',
      message: `submission probe failed: ${String(err).slice(0, 120)}`,
      detail: { subId },
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Notification (macOS notification center via osascript, best-effort)
// ---------------------------------------------------------------------------

function notifyFailure(summary: HealthRunSummary): void {
  if (platform() !== 'darwin') return;
  const failed = summary.checks.filter(c => c.status === 'fail');
  if (failed.length === 0) return;
  const title = `Health: ${failed.length} fail${failed.length === 1 ? '' : 's'}`;
  const body = failed.slice(0, 3).map(c => `${c.target}: ${c.message}`).join(' | ');
  const safeTitle = title.replace(/"/g, '\\"');
  const safeBody = body.replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 240);
  try {
    execFileSync('/usr/bin/osascript', [
      '-e',
      `display notification "${safeBody}" with title "${safeTitle}" sound name "Sosumi"`,
    ], { stdio: 'ignore', timeout: 5000 });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HISTORY_DIR = join(homedir(), '.agentic-treasury');
const HISTORY_FILE = join(HISTORY_DIR, 'health-history.jsonl');
const HISTORY_CAP = 5000;

function resolveConfigPath(): string {
  // Honor explicit override first.
  const override = process.env['HEALTH_CONFIG'];
  if (override) return override;
  // Resolve relative to this script's location so launchd (which runs
  // from WorkingDirectory) and ad-hoc invocations both work without
  // ambiguity.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'config', 'watched.json');
}

function loadConfig(): WatchedConfig {
  const path = resolveConfigPath();
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<WatchedConfig>;
  return {
    launchdJobs: parsed.launchdJobs ?? [],
    httpProbes: parsed.httpProbes ?? [],
    superteamSubmissions: parsed.superteamSubmissions ?? [],
  };
}

async function runHealthCheck(): Promise<HealthRunSummary> {
  const config = loadConfig();
  const nowMs = Date.now();
  const checks: CheckResult[] = [];

  for (const job of config.launchdJobs) {
    checks.push(...checkLaunchdJob(job, nowMs));
  }

  const httpResults = await Promise.all(config.httpProbes.map(checkHttpProbe));
  checks.push(...httpResults);

  // Prefer the memory db as the source of truth for "which submissions
  // should we be tracking?". Falls back to the Doppler env-var list in
  // the config if the memory db is empty (first boot, fresh machine, or
  // a node where node:sqlite isn't available). Lazy import so the
  // health-check still runs if the memory module fails to load.
  let memorySubIds: string[] = [];
  try {
    const mem = await import('../src/memory/index.ts');
    memorySubIds = mem
      .listSubmissions({ platform: 'superteam', status: 'pending' })
      .map(s => s.id);
  } catch (err) {
    checks.push({
      kind: 'superteam-submission',
      target: 'memory-source',
      status: 'warn',
      message: `memory module unavailable, falling back to Doppler env list: ${String(err).slice(0, 120)}`,
    });
  }

  if (memorySubIds.length > 0) {
    const memResults = await Promise.all(
      memorySubIds.map(id => checkSuperteamSubmissionById(id, `memory:${id.slice(0, 8)}`)),
    );
    checks.push(...memResults);
  } else {
    const subResults = await Promise.all(config.superteamSubmissions.map(checkSuperteamSubmission));
    checks.push(...subResults);
  }

  const overall = aggregateStatus(checks);
  const summary: HealthRunSummary = {
    timeISO: new Date(nowMs).toISOString(),
    overall,
    ok: checks.filter(c => c.status === 'ok').length,
    warn: checks.filter(c => c.status === 'warn').length,
    fail: checks.filter(c => c.status === 'fail').length,
    checks,
  };
  return summary;
}

function appendHistory(summary: HealthRunSummary): void {
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  appendFileSync(HISTORY_FILE, JSON.stringify(summary) + '\n');
  // Only truncate occasionally to amortize the cost. The cheap
  // heuristic: peek at file size and only rewrite when it's larger than
  // a generous bound (5000 lines × ~2 KB each ≈ 10 MB).
  try {
    const sz = statSync(HISTORY_FILE).size;
    if (sz > 12_000_000) truncateJsonlToLastN(HISTORY_FILE, HISTORY_CAP);
  } catch { /* best-effort */ }
}

// Only run main when executed as a script, not when imported by tests.
const invokedAsScript = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsScript) {
  runHealthCheck().then(summary => {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    appendHistory(summary);
    if (summary.fail > 0) notifyFailure(summary);
    process.exit(summary.fail > 0 ? 1 : 0);
  }).catch(err => {
    console.error('[health-check] fatal:', String(err));
    process.exit(2);
  });
}
