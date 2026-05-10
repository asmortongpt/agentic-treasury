/**
 * Trepa Flash Pool multi-bot swarm — outcome-band variant.
 *
 *   node --experimental-strip-types --no-warnings swarm.ts --dry-run [--count N]
 *   node --env-file=.env swarm.ts                               # production
 *
 * Why a swarm? Trepa supports several wallets in one process via
 * `trepa.bots.run`. The "outcome band" pattern (documented at
 * https://docs.trepa.io/developers/swarms#different-behaviour-per-bot)
 * has each bot predict a value shifted off a shared fair anchor by
 * `(index - (count - 1) / 2) * spacing`. The point is hedging: if you
 * spread guesses across the plausible 30-second range, at least one bot
 * is close regardless of which way price moves.
 *
 * The bot.ts file in this folder already produces a vol-adjusted spot
 * forecast (`spot + capped drift nudge`). Here we reuse that forecast as
 * the *anchor* of the band, then derive a sensible `spacing` from the
 * same `typicalMoveDollars` the strategy already exposes. That ties the
 * band to live volatility instead of being a magic number like 400.
 *
 * Math: anchor = forecast(spot, samples).prediction
 *       spacing = bandSpacingFraction * typicalMoveDollars
 *       value[i] = anchor + (i - (count - 1) / 2) * spacing
 *
 * Pure-function band math lives in `bandPosition` so swarm.test.ts can
 * exercise it without I/O or SDK installed.
 */

import {
  forecast,
  DEFAULT_CONFIG,
  type Forecast,
  type PriceSample,
  type StrategyConfig,
} from './strategy.ts';

export interface SwarmConfig {
  /** How many bots in the swarm (>= 1). */
  count: number;
  /**
   * Band spacing as a fraction of one typical 30s move. 0.5 means each
   * adjacent bot is half a typical move apart; the full band width
   * across (count-1) gaps is (count-1) * 0.5 typical moves.
   *
   * Default 0.5 keeps a 3-bot swarm covering ±0.5 typical moves and a
   * 5-bot swarm covering ±1.0 typical moves, which approximately spans
   * the 30-second outcome distribution.
   */
  bandSpacingFraction: number;
}

export const DEFAULT_SWARM_CONFIG: SwarmConfig = {
  count: 3,
  bandSpacingFraction: 0.5,
};

/**
 * Pure-function: given a band anchor, a slot, and a spacing, return the
 * value that bot should predict. This is the entire mechanic of the
 * outcome-band pattern, isolated so it is trivially auditable.
 */
export function bandPosition(
  anchor: number,
  index: number,
  count: number,
  spacing: number,
): number {
  if (!Number.isFinite(anchor)) throw new Error('bandPosition: anchor not finite');
  if (!Number.isInteger(count) || count < 1) throw new Error('bandPosition: count must be a positive integer');
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`bandPosition: index ${index} out of range for count ${count}`);
  }
  if (!Number.isFinite(spacing) || spacing < 0) throw new Error('bandPosition: spacing must be finite and non-negative');
  return anchor + (index - (count - 1) / 2) * spacing;
}

export interface BandPlan {
  anchor: number;
  spacing: number;
  count: number;
  /** Predicted value per bot, ordered by index. */
  predictions: number[];
}

/**
 * Build the full per-bot prediction set from the same forecast bot.ts
 * already produces, plus a swarm config. Returned as plain data so a
 * reviewer can verify symmetry, spacing, and the anchor by eye.
 */
export function buildBandPlan(
  f: Forecast,
  swarm: SwarmConfig = DEFAULT_SWARM_CONFIG,
): BandPlan {
  const anchor = f.prediction;
  const spacing = swarm.bandSpacingFraction * f.typicalMoveDollars;
  const predictions = Array.from({ length: swarm.count }, (_, i) =>
    bandPosition(anchor, i, swarm.count, spacing),
  );
  return { anchor, spacing, count: swarm.count, predictions };
}

/* -------------------------------------------------------------------------- */
/* Live price feeds (mirroring bot.ts so dry-run output stays consistent).    */
/* -------------------------------------------------------------------------- */

const PRIMARY = {
  ticker: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
  candles: 'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60',
};
const FALLBACK = {
  ticker: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
  candles: 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60',
};

interface CoinbaseTickerResponse { data: { amount: string } }
interface BinanceTickerResponse { price: string }
type CoinbaseCandle = [time: number, low: number, high: number, open: number, close: number, volume: number];
type BinanceKline = [openTime: number, open: string, high: string, low: string, close: string, volume: string, ...rest: unknown[]];

async function fetchSpot(): Promise<number> {
  try {
    const res = await fetch(PRIMARY.ticker);
    if (res.ok) {
      const { data } = (await res.json()) as CoinbaseTickerResponse;
      return Number(data.amount);
    }
  } catch { /* fall through */ }
  const res = await fetch(FALLBACK.ticker);
  if (!res.ok) throw new Error(`fetchSpot: both feeds failed (last HTTP ${res.status})`);
  const { price } = (await res.json()) as BinanceTickerResponse;
  return Number(price);
}

async function fetchRecentSamples(): Promise<PriceSample[]> {
  try {
    const res = await fetch(PRIMARY.candles);
    if (res.ok) {
      const candles = (await res.json()) as CoinbaseCandle[];
      return candles
        .slice()
        .reverse()
        .map(c => ({ t: c[0] * 1000, p: c[4] }));
    }
  } catch { /* fall through */ }
  const res = await fetch(FALLBACK.candles);
  if (!res.ok) throw new Error(`fetchRecentSamples: both feeds failed (last HTTP ${res.status})`);
  const klines = (await res.json()) as BinanceKline[];
  return klines.map(k => ({ t: k[0], p: Number(k[4]) }));
}

/* -------------------------------------------------------------------------- */
/* Dry-run and production wrappers.                                            */
/* -------------------------------------------------------------------------- */

function parseCountArg(argv: string[], fallback: number): number {
  const i = argv.indexOf('--count');
  if (i < 0 || i === argv.length - 1) return fallback;
  const raw = argv[i + 1]!;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--count must be a positive integer, got "${raw}"`);
  return n;
}

export async function dryRun(
  argv: string[] = process.argv,
  config: StrategyConfig = DEFAULT_CONFIG,
  swarmDefaults: SwarmConfig = DEFAULT_SWARM_CONFIG,
): Promise<void> {
  const count = parseCountArg(argv, swarmDefaults.count);
  const swarm: SwarmConfig = { ...swarmDefaults, count };

  const [spot, samples] = await Promise.all([fetchSpot(), fetchRecentSamples()]);
  const f = forecast(spot, samples, config);
  const plan = buildBandPlan(f, swarm);

  console.log(JSON.stringify({
    spotUSD: f.spot,
    anchorUSD: plan.anchor,
    bandSpacingUSD: plan.spacing,
    botCount: plan.count,
    botPredictionsUSD: plan.predictions,
    components: {
      driftDollarsRaw: f.driftDollars,
      typicalMove30sUSD: f.typicalMoveDollars,
      capDollars: f.capDollars,
      cappedNudgeUSD: f.cappedNudge,
      sigmaPerSecond: f.sigmaPerSecond,
      sampleCount: samples.length,
      bandSpacingFraction: swarm.bandSpacingFraction,
    },
  }, null, 2));
}

async function production(): Promise<void> {
  // Lazy-import so dry-run runs without @trepa/sdk installed. Same
  // pattern as bot.ts. The SDK loads `credentialsFromEnv()` which reads
  // TREPA_API_KEY_1/PRIVATE_KEY_1, _2/_2, … so the swarm size is set by
  // however many credential pairs are in the environment.
  const { credentialsFromEnv, Trepa } = await import('@trepa/sdk');
  const trepa = new Trepa({ credentials: credentialsFromEnv() });

  await trepa.bots.run(({ index, count }) => ({
    predict: async (pool) => {
      const [spot, samples] = await Promise.all([fetchSpot(), fetchRecentSamples()]);
      const f = forecast(spot, samples);
      const spacing = DEFAULT_SWARM_CONFIG.bandSpacingFraction * f.typicalMoveDollars;
      const value = bandPosition(f.prediction, index, count, spacing);
      return { value, stake: pool.min_stake };
    },
  }));
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run') || !process.env['TREPA_API_KEY_1'];
  if (isDryRun) {
    console.error('[mode] dry-run — no SDK, no signing. Set TREPA_API_KEY_1..N + TREPA_PRIVATE_KEY_1..N to go live.');
    await dryRun();
  } else {
    console.error('[mode] production — using @trepa/sdk and N wallet credentials.');
    await production();
  }
}

// Only run main() when executed as the entry point, not when imported.
// Detecting entrypoint: process.argv[1] ends with this file.
const argv1 = process.argv[1] ?? '';
if (argv1.endsWith('swarm.ts') || argv1.endsWith('swarm.js')) {
  main().catch(err => { console.error(err); process.exit(1); });
}
