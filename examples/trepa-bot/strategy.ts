/**
 * Trepa Flash Pool prediction strategy: volatility-adjusted spot + drift.
 *
 * The naive bot from the Trepa quickstart predicts the current Binance
 * BTC/USDT spot price. That's already a reasonable baseline — about half
 * the field beats the median, by definition. The interesting question is
 * whether you can push your *expected* error below the median's by being
 * smarter about where the price is likely to be in 30 seconds.
 *
 * This strategy nudges spot by a small drift term derived from the last
 * few one-second returns, scaled by the recent realized volatility. In
 * calm tape, the nudge is small. When the tape has direction, the nudge
 * leans that way. The size of the nudge is bounded by a fraction of one
 * "typical move" (Trepa's volatility calibration unit), so the bot never
 * tries to be a hero.
 *
 * Math, mirroring Trepa's own scoring:
 *   σ = stddev of recent 1-minute log-returns
 *   typical move (60s) ≈ price · σ
 *   drift = avg(last_n returns) · price        // dollar drift over the window
 *   nudge = clamp(drift, ±k · typical_move)    // k = 0.25
 *   prediction = price + nudge
 *
 * No wallet, no signing. Just the math. The bot.ts file feeds these
 * numbers into trepa.bots.run.
 */

export interface PriceSample {
  /** Unix milliseconds. */
  t: number;
  /** BTC/USDT mid price at time t. */
  p: number;
}

export interface StrategyConfig {
  /** How many recent samples to average for drift. */
  driftWindow: number;
  /** Cap on |nudge| as fraction of one typical 30s move. 0.25 = quarter move. */
  driftCapFraction: number;
  /**
   * Seconds between samples in the input series. Coinbase 1m candles → 60.
   * Binance 1s candles → 1. Used to convert per-sample σ into a 30-second
   * (Trepa Flash Pool round duration) typical move.
   */
  sampleIntervalSeconds: number;
  /** Trepa round duration in seconds. */
  roundSeconds: number;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  driftWindow: 5,
  driftCapFraction: 0.25,
  sampleIntervalSeconds: 60, // matches the bot's Coinbase candle source
  roundSeconds: 30,
};

function logReturns(samples: PriceSample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!.p;
    const b = samples[i]!.p;
    if (a > 0 && b > 0) out.push(Math.log(b / a));
  }
  return out;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export interface Forecast {
  /** Final predicted BTC price. */
  prediction: number;
  /** Components, exposed so callers (and audit logs) can see the math. */
  spot: number;
  driftDollars: number;
  typicalMoveDollars: number;
  capDollars: number;
  cappedNudge: number;
  sigmaPerSecond: number;
}

/**
 * Pure function. Takes the latest spot and recent samples, returns the
 * forecast plus the math we used to get there. Anyone reading the audit
 * log can verify the bot didn't go off-road.
 */
export function forecast(
  spot: number,
  recentSamples: PriceSample[],
  config: StrategyConfig = DEFAULT_CONFIG,
): Forecast {
  const returns = logReturns(recentSamples);
  if (returns.length < 2) {
    return {
      prediction: spot,
      spot,
      driftDollars: 0,
      typicalMoveDollars: 0,
      capDollars: 0,
      cappedNudge: 0,
      sigmaPerSecond: 0,
    };
  }

  const sigmaPerSample = stddev(returns);
  // Convert per-sample σ to per-second, then scale to round duration.
  // For Brownian motion: σ(T) = σ(unit) × sqrt(T / unit).
  const sigmaPerSecond = sigmaPerSample / Math.sqrt(config.sampleIntervalSeconds);
  const typicalMove30s = spot * sigmaPerSecond * Math.sqrt(config.roundSeconds);

  const driftWindow = Math.min(config.driftWindow, returns.length);
  const recentReturns = returns.slice(-driftWindow);
  const meanReturn = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
  // Drift over the round duration projected from the mean per-sample return.
  const driftDollars = meanReturn * spot * (config.roundSeconds / config.sampleIntervalSeconds);

  const capDollars = config.driftCapFraction * typicalMove30s;
  const cappedNudge = clamp(driftDollars, -capDollars, capDollars);

  return {
    prediction: spot + cappedNudge,
    spot,
    driftDollars,
    typicalMoveDollars: typicalMove30s,
    capDollars,
    cappedNudge,
    sigmaPerSecond,
  };
}
