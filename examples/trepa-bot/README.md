# Trepa Flash Pool bot — minimal, testable, dry-runnable

A working Trepa Flash Pool prediction bot. Two-mode design so reviewers
can verify the math without holding any keys.

## What it does

- Fetches BTC spot from Coinbase (or Binance, fallback) and the recent
  candle history.
- Runs a small pure-function strategy: `prediction = spot + nudge`,
  where `nudge` is a drift estimate from the last few one-minute log
  returns, clamped to a fraction of one typical 30-second BTC move.
- In **dry-run** mode, prints the forecast and all components.
- In **production** mode, hands the same forecast to
  `trepa.bots.run` from `@trepa/sdk`, which signs and submits via your
  wallet.

The strategy itself is in `strategy.ts` — pure functions, no I/O, fully
unit-tested in `strategy.test.ts`.

## Run dry-run (no SDK, no creds)

```bash
node --experimental-strip-types --no-warnings bot.ts --dry-run
```

Sample output (real, against live Coinbase data):

```json
{
  "spotUSD": 81025.005,
  "predictionUSD": 81019.5266397907,
  "nudgeUSD": -5.478360209306275,
  "components": {
    "driftDollarsRaw": -6.492197974993528,
    "typicalMove30sUSD": 21.9134408372251,
    "capDollars": 5.478360209306275,
    "sigmaPerSecond": 0.000049377702842487035,
    "sampleCount": 350
  }
}
```

The cap is binding here: raw drift was −\$6.49, capped to −\$5.48
(0.25 × \$21.91 typical 30-second move). That's the bot saying "I see
downward pressure, but I refuse to lean more than a quarter of a
typical move on it."

## Run production (real predictions)

```bash
# .env (don't commit this file)
TREPA_API_KEY_1=trp_…
TREPA_PRIVATE_KEY_1=…

node --experimental-strip-types --no-warnings --env-file=.env bot.ts
```

Then it just runs Trepa's official quickstart pattern with our
`forecast()` plugged into `predict`:

```ts
await trepa.bots.run({
  predict: async (pool) => {
    const [spot, samples] = await Promise.all([fetchSpot(), fetchRecentSamples()]);
    const { prediction } = forecast(spot, samples);
    return { value: prediction, stake: pool.min_stake };
  },
});
```

## Run the tests

```bash
node --experimental-strip-types --no-warnings --test strategy.test.ts
```

Expected: `pass 6, fail 0`.

The tests check:
1. Flat tape → prediction equals spot
2. Insufficient samples → prediction equals spot
3. Upward trend → positive nudge, within cap
4. Downward trend → negative nudge, within cap
5. Cap binds when raw drift exceeds the threshold
6. Loosening `driftCapFraction` raises the cap as expected

## Why this design

Three things matter for a Trepa bot:

1. **Don't be a hero.** Trepa's accuracy weight is `(1 / (1 + r_i))^6`,
   so beating the median by a hair is worth a lot. Beating it by a lot
   isn't worth proportionally more, and the 100× cap eats most of the
   upside on outlier rounds. Small consistent edge ≫ big occasional
   bet.
2. **Audit-friendly math.** The strategy is a pure function. Every
   component is in the output (drift, sigma, cap). If a reviewer
   suspects the bot is doing something stupid, they can read the JSON
   and check.
3. **Deterministic given inputs.** Same prices in → same prediction
   out. No hidden RNG, no secret models. Easy to backtest, easy to
   audit, easy to harden.

## What this *doesn't* do (yet)

- **No order-book microstructure.** A real edge in BTC at 30-second
  horizon probably comes from imbalance, last-trade direction, and
  taker flow — none of which a candle stream gives you. This bot is
  the floor, not the ceiling.
- **No multi-account swarm.** Trepa supports it natively
  (`credentials: [...]`), but a swarm needs N real accounts and is
  out of scope for a 200-line demo.
- **No reinforcement on outcome.** A real production bot would log
  every prediction and outcome, attribute its hits and misses, and
  tune `driftCapFraction` and `driftWindow` automatically. Treat
  `DEFAULT_CONFIG` as a starting point, not a final answer.

The point is to be a clean, honest baseline that you can fork and
improve. The pure-function shape of `forecast()` makes it trivial to
swap in any signal you trust more than mean-reversion-on-candles.

## License

MIT.
