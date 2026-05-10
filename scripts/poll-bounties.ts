/**
 * Bounty poller — checks every agent-friendly earning channel I've
 * verified is reachable from an autonomous loop, diffs against last
 * seen state, and surfaces anything new.
 *
 *   node --experimental-strip-types --no-warnings scripts/poll-bounties.ts
 *
 * Designed to be invoked from launchd (one-shot, exits when done).
 * Maintains state in $HOME/.agentic-treasury/state.json so consecutive
 * runs don't re-announce the same opportunities.
 *
 * Channels polled:
 *   - Superteam Earn agent-eligible listings (requires SUPERTEAM_AGENT_API_KEY)
 *   - Sherlock open audit contests (no auth needed)
 *   - Polkadot child-bounties via Polkassembly (no auth needed)
 *
 * Surface mechanism: stdout JSON line per new opportunity, AND a
 * macOS notification via `osascript` if available (silently ignored
 * on non-macOS).
 *
 * Safe to run frequently — every endpoint is rate-limit friendly at
 * 1 request/poll. Don't poll faster than once per minute.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

const STATE_DIR = join(homedir(), '.agentic-treasury');
const STATE_FILE = join(STATE_DIR, 'state.json');

interface Opportunity {
  channel: string;       // 'superteam' | 'sherlock' | 'polkadot'
  id: string;            // channel-scoped opportunity id
  url: string;           // human-readable link
  title: string;
  rewardUsd: number | null; // best-effort USD value (or null if not denominated)
  deadlineISO: string | null;
  meta?: Record<string, unknown>; // channel-specific extras
}

interface State {
  /** seen[channel][id] = first-seen ISO timestamp */
  seen: Record<string, Record<string, string>>;
  lastRun?: string;
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return { seen: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State;
  } catch {
    return { seen: {} };
  }
}

function saveState(s: State): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function notify(title: string, body: string): void {
  if (platform() !== 'darwin') return;
  // Use osascript so the notification appears in the macOS notification
  // center. Quote-escape both fields. If osascript fails, swallow —
  // notifications are best-effort.
  const safeTitle = title.replace(/"/g, '\\"');
  const safeBody = body.replace(/"/g, '\\"').replace(/\n/g, ' ');
  try {
    execSync(`osascript -e 'display notification "${safeBody}" with title "${safeTitle}" sound name "Glass"'`, {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Superteam Earn agent-eligible listings
// ---------------------------------------------------------------------------

async function pollSuperteam(): Promise<Opportunity[]> {
  const key = process.env['SUPERTEAM_AGENT_API_KEY'];
  if (!key) {
    console.error('[superteam] skipped: SUPERTEAM_AGENT_API_KEY not set');
    return [];
  }
  const res = await fetch('https://superteam.fun/api/agents/listings/live?take=50', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error(`[superteam] HTTP ${res.status}`);
    return [];
  }
  const items = (await res.json()) as Array<{
    id: string; title: string; slug: string; rewardAmount: number; token: string;
    deadline: string; agentAccess: string; type: string; isWinnersAnnounced: boolean;
  }>;
  const now = Date.now();
  return items
    .filter(b => !b.isWinnersAnnounced && b.deadline && new Date(b.deadline).getTime() > now)
    .map(b => ({
      channel: 'superteam',
      id: b.id,
      url: `https://earn.superteam.fun/listings/${b.slug}`,
      title: b.title,
      rewardUsd: typeof b.rewardAmount === 'number' ? b.rewardAmount : null,
      deadlineISO: b.deadline,
      meta: { token: b.token, type: b.type, agentAccess: b.agentAccess },
    }));
}

// ---------------------------------------------------------------------------
// Sherlock audit contests
// ---------------------------------------------------------------------------

async function pollSherlock(): Promise<Opportunity[]> {
  const out: Opportunity[] = [];
  // First page only — Sherlock returns recent contests first, and any
  // currently-open ones will be on page 1 since they're sorted by ends_at.
  const res = await fetch('https://audits.sherlock.xyz/api/contests?page=1');
  if (!res.ok) {
    console.error(`[sherlock] HTTP ${res.status}`);
    return out;
  }
  const data = (await res.json()) as { items: Array<{ id: number; title: string; starts_at: number; ends_at: number; prize_pool: number; is_best_efforts: boolean }> };
  const now = Date.now() / 1000;
  for (const c of data.items) {
    if (c.starts_at <= now && now < c.ends_at) {
      out.push({
        channel: 'sherlock',
        id: String(c.id),
        url: `https://audits.sherlock.xyz/contests/${c.id}`,
        title: c.title,
        rewardUsd: c.prize_pool,
        deadlineISO: new Date(c.ends_at * 1000).toISOString(),
        meta: { isBestEfforts: c.is_best_efforts },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Polkadot child-bounties via Polkassembly
// ---------------------------------------------------------------------------

async function pollPolkadot(): Promise<Opportunity[]> {
  // Filter to active/proposed status only. The Polkassembly API requires
  // the x-network header to scope the query to a chain.
  const url = 'https://api.polkassembly.io/api/v1/listing/on-chain-posts?proposalType=child_bounties&page=1&listingLimit=25&trackStatus=active';
  const res = await fetch(url, { headers: { 'x-network': 'polkadot' } });
  if (!res.ok) {
    console.error(`[polkadot] HTTP ${res.status}`);
    return [];
  }
  const data = (await res.json()) as { posts: Array<{ post_id: number; title: string; reward: string; status: string; created_at: string }> };
  // DOT amount is in chain native units (10 decimals). We don't price it
  // in USD here — that would require an oracle call. Surface raw DOT
  // amount in meta so the consumer can decide.
  return (data.posts ?? [])
    .filter(p => p.status === 'Added' || p.status === 'Proposed' || p.status === 'Active')
    .map(p => ({
      channel: 'polkadot',
      id: String(p.post_id),
      url: `https://polkadot.polkassembly.io/child_bounty/${p.post_id}`,
      title: p.title ?? `Child bounty #${p.post_id}`,
      rewardUsd: null, // DOT-denominated; price separately if needed
      deadlineISO: null,
      meta: { rewardDOTraw: p.reward, status: p.status, createdAt: p.created_at },
    }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const state = loadState();
  state.seen ??= {};

  const pollers: Array<{ name: string; fn: () => Promise<Opportunity[]> }> = [
    { name: 'superteam', fn: pollSuperteam },
    { name: 'sherlock', fn: pollSherlock },
    { name: 'polkadot', fn: pollPolkadot },
  ];

  const allFound: Opportunity[] = [];
  const newOpps: Opportunity[] = [];

  for (const { name, fn } of pollers) {
    try {
      const opps = await fn();
      allFound.push(...opps);
      state.seen[name] ??= {};
      const seenForChannel = state.seen[name];
      for (const opp of opps) {
        if (!seenForChannel[opp.id]) {
          seenForChannel[opp.id] = new Date().toISOString();
          newOpps.push(opp);
        }
      }
    } catch (err) {
      console.error(`[${name}] error: ${String(err).slice(0, 200)}`);
    }
  }

  state.lastRun = new Date().toISOString();
  saveState(state);

  // Surface new opportunities: stdout JSON line + macOS notification.
  for (const opp of newOpps) {
    process.stdout.write(JSON.stringify({ type: 'new-opportunity', ...opp }) + '\n');
  }

  // Summary line for log readers
  console.error(`[poll] ${new Date().toISOString()} | superteam:${allFound.filter(o => o.channel === 'superteam').length} sherlock:${allFound.filter(o => o.channel === 'sherlock').length} polkadot:${allFound.filter(o => o.channel === 'polkadot').length} | new:${newOpps.length}`);

  if (newOpps.length > 0) {
    const top = newOpps.slice(0, 3).map(o => {
      const r = o.rewardUsd ? `$${o.rewardUsd}` : (o.meta?.['rewardDOTraw'] ? `${String(o.meta['rewardDOTraw']).slice(0, 8)} DOT` : '?');
      return `${o.channel}/${r} ${o.title.slice(0, 40)}`;
    }).join(' • ');
    notify(`${newOpps.length} new bountie${newOpps.length === 1 ? '' : 's'}`, top);
  }
}

main().catch(err => {
  console.error('[poll] fatal:', String(err));
  process.exit(1);
});
