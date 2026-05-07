/**
 * Trepa Flash Pool prediction bot.
 *
 *   node --env-file=.env bot.ts                 # production: places real predictions
 *   node bot.ts --dry-run                       # dry-run: prints forecasts only
 *
 * In dry-run mode, no .env is needed. The bot fetches Binance BTC/USDT
 * spot and 1-second klines, runs the strategy from ./strategy.ts, and
 * prints what it *would* predict. No wallet, no signing, no SDK
 * dependency. That's the audit-friendly mode for reviewers.
 *
 * In production mode, the bot loads `@trepa/sdk` and runs trepa.bots.run.
 * Same forecast function feeds both modes; the difference is only that
 * production submits the result to Trepa.
 */

import { forecast, DEFAULT_CONFIG, type PriceSample } from './strategy.ts';

/**
 * Price source selection notes.
 *
 * Trepa settles against Binance BTC/USDT trade data, but binance.com is
 * geoblocked in the US (HTTP 451). For *forecasting* the choice of feed
 * doesn't have to match the settlement venue — what matters is that the
 * feed tracks the same underlying price closely. Coinbase's BTC-USD
 * pair has a tight basis to Binance's BTC/USDT, so we use Coinbase here
 * with a Binance fallback for reviewers running outside US jurisdictions.
 *
 * If you're running from a region where Binance is reachable, prefer it.
 * If you're in the US, the included Coinbase path Just Works.
 */
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
  // Try Coinbase first.
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
  // Coinbase candles come in newest-first, so we reverse to chronological.
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

async function dryRun(): Promise<void> {
  const [spot, samples] = await Promise.all([fetchSpot(), fetchRecentSamples()]);
  const f = forecast(spot, samples, DEFAULT_CONFIG);
  console.log(JSON.stringify({
    spotUSD: f.spot,
    predictionUSD: f.prediction,
    nudgeUSD: f.cappedNudge,
    components: {
      driftDollarsRaw: f.driftDollars,
      typicalMove30sUSD: f.typicalMoveDollars,
      capDollars: f.capDollars,
      sigmaPerSecond: f.sigmaPerSecond,
      sampleCount: samples.length,
    },
  }, null, 2));
}

async function production(): Promise<void> {
  // Lazy-import so dry-run doesn't require @trepa/sdk to be installed.
  const sdk = await import('@trepa/sdk');
  const { credentialsFromEnv, Trepa } = sdk as unknown as {
    credentialsFromEnv: () => Array<{ apiKey: string; privateKey: string }>;
    Trepa: new (opts: { credentials: ReturnType<() => Array<{ apiKey: string; privateKey: string }>> }) => {
      bots: { run: (opts: { predict: (pool: { min_stake: number }) => Promise<{ value: number; stake: number }> }) => Promise<void> };
    };
  };

  const trepa = new Trepa({ credentials: credentialsFromEnv() });

  await trepa.bots.run({
    predict: async (pool) => {
      const [spot, samples] = await Promise.all([fetchSpot(), fetchRecentSamples()]);
      const { prediction } = forecast(spot, samples);
      return { value: prediction, stake: pool.min_stake };
    },
  });
}

async function main(): Promise<void> {
  const isDryRun = process.argv.includes('--dry-run') || !process.env['TREPA_API_KEY_1'];
  if (isDryRun) {
    console.error('[mode] dry-run — no SDK, no signing. Set TREPA_API_KEY_1 + TREPA_PRIVATE_KEY_1 to go live.');
    await dryRun();
  } else {
    console.error('[mode] production — using @trepa/sdk and your wallet credentials.');
    await production();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
