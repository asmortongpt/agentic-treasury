/**
 * Live demo HTTP server for the Agentic Treasury repo.
 *
 * Exposes two read-only endpoints that prove the integrations work
 * end-to-end against real providers, with no signing and no keys:
 *
 *   GET /                       → human-readable index
 *   GET /healthz                → liveness probe
 *   GET /api/trepa/forecast     → live BTC forecast from the strategy
 *   GET /api/jupiter/quote?in=USDC&out=jupSoL&amount=10000000
 *                                → live Jupiter Swap V2 quote
 *
 * Designed for Railway / Fly / Render. Listens on $PORT, defaulting to
 * 3000. No external DB, no auth, no state.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { JupiterClient, COMMON_MINTS } from './src/jupiter.ts';
import { forecast } from './examples/trepa-bot/strategy.ts';

const PORT = Number(process.env['PORT'] ?? 3000);

interface BinanceKline { 0: number; 4: string }
interface CoinbaseTicker { data: { amount: string } }
type CoinbaseCandle = [time: number, low: number, high: number, open: number, close: number, volume: number];

async function fetchSpot(): Promise<number> {
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot');
    if (r.ok) {
      const { data } = (await r.json()) as CoinbaseTicker;
      return Number(data.amount);
    }
  } catch { /* fall through */ }
  const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT');
  if (!r.ok) throw new Error(`spot: HTTP ${r.status}`);
  const { price } = (await r.json()) as { price: string };
  return Number(price);
}

async function fetchSamples() {
  try {
    const r = await fetch('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60');
    if (r.ok) {
      const candles = (await r.json()) as CoinbaseCandle[];
      return candles.slice().reverse().map(c => ({ t: c[0] * 1000, p: c[4] }));
    }
  } catch { /* fall through */ }
  const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60');
  if (!r.ok) throw new Error(`klines: HTTP ${r.status}`);
  const klines = (await r.json()) as BinanceKline[];
  return klines.map(k => ({ t: k[0], p: Number(k[4]) }));
}

const jup = new JupiterClient();

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'no-store');
  res.end(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

const INDEX_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>Agentic Treasury — Live Demo</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #222; }
  h1 { font-size: 22px; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  pre { background: #0a0a0a; color: #d0d0d0; padding: 16px; border-radius: 6px; overflow-x: auto; }
  a { color: #0366d6; }
  .endpoint { margin: 18px 0; padding: 14px; border: 1px solid #e1e4e8; border-radius: 6px; }
</style>
</head><body>
<h1>Agentic Treasury — Live Demo</h1>
<p>Read-only HTTP wrapper around the integrations in
<a href="https://github.com/asmortongpt/agentic-treasury">asmortongpt/agentic-treasury</a>.
No keys. No signing. Live data.</p>

<div class="endpoint">
  <strong>GET /api/trepa/forecast</strong>
  <p>Live BTC forecast from the volatility-adjusted spot+drift strategy.
  Same pure function the bot uses against Trepa Flash Pools.</p>
  <p><a href="/api/trepa/forecast">→ Try it</a></p>
</div>

<div class="endpoint">
  <strong>GET /api/jupiter/quote?in=USDC&amp;out=jupSoL&amp;amount=10000000</strong>
  <p>Live Jupiter Swap V2 quote. <code>in</code> and <code>out</code>
  accept either symbols (USDC, USDT, jupUSD, jupSoL, USDG, SOL) or full
  mint addresses. <code>amount</code> is in atomic units of the input
  token.</p>
  <p><a href="/api/jupiter/quote?in=USDC&out=jupSoL&amount=10000000">→ Try it</a></p>
</div>

<div class="endpoint">
  <strong>GET /healthz</strong> — liveness probe
</div>

<p style="color:#666;margin-top:30px">Source: <a href="https://github.com/asmortongpt/agentic-treasury">github.com/asmortongpt/agentic-treasury</a></p>
</body></html>`;

function resolveMint(s: string): string {
  // Case-insensitive symbol lookup. COMMON_MINTS has both upper-case
  // (USDC, USDT, SOL) and mixed-case (jupUSD, jupSoL) keys, so we
  // match against a case-folded view rather than uppercasing the input.
  const target = s.toLowerCase();
  for (const [symbol, mint] of Object.entries(COMMON_MINTS)) {
    if (symbol.toLowerCase() === target) return mint;
  }
  return s; // Already a mint address (or unknown — Jupiter will reject).
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
  }

  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true, time: new Date().toISOString() });
  }

  if (url.pathname === '/api/trepa/forecast') {
    const [spot, samples] = await Promise.all([fetchSpot(), fetchSamples()]);
    const f = forecast(spot, samples);
    return send(res, 200, {
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
      sourceFeeds: ['Coinbase BTC-USD primary', 'Binance BTC/USDT fallback'],
      strategy: 'volatility-adjusted spot+drift, capped at 0.25 × typical 30s move',
      time: new Date().toISOString(),
    });
  }

  if (url.pathname === '/api/jupiter/quote') {
    const inMint = resolveMint(url.searchParams.get('in') ?? 'USDC');
    const outMint = resolveMint(url.searchParams.get('out') ?? 'jupSoL');
    const amount = url.searchParams.get('amount') ?? '10000000';
    const slippageBps = Number(url.searchParams.get('slippageBps') ?? '50');
    const q = await jup.quote({
      inputMint: inMint,
      outputMint: outMint,
      amount: BigInt(amount),
      slippageBps,
    });
    return send(res, 200, {
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      inAmount: q.inAmount,
      outAmount: q.outAmount,
      priceImpactPct: q.priceImpactPct,
      slippageBps: q.slippageBps,
      hops: q.routePlan.map(r => r.swapInfo.label),
      time: new Date().toISOString(),
    });
  }

  return send(res, 404, { error: 'not_found', path: url.pathname });
}

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error(err);
    send(res, 500, { error: 'internal', message: String(err).slice(0, 200) });
  });
});

server.listen(PORT, () => {
  console.log(`agentic-treasury server listening on :${PORT}`);
});
