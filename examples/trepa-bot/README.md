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
node --experimental-strip-types --no-warnings --test strategy.test.ts swarm.test.ts
```

Expected: `pass 15, fail 0`.

The strategy tests check:
1. Flat tape → prediction equals spot
2. Insufficient samples → prediction equals spot
3. Upward trend → positive nudge, within cap
4. Downward trend → negative nudge, within cap
5. Cap binds when raw drift exceeds the threshold
6. Loosening `driftCapFraction` raises the cap as expected

The swarm tests check the outcome-band math from
[`docs.trepa.io/developers/swarms`](https://docs.trepa.io/developers/swarms):

7. Center bot of an odd-count swarm predicts the anchor unchanged
8. `count=1` always returns the anchor
9. Edge bots are exactly `±((count-1)/2)·spacing` from anchor
10. Bots are symmetric around the anchor for any count and spacing
11. Even-count swarm has no exact center; mid pair is `±spacing/2`
12. `bandPosition` rejects bad inputs (NaN anchor, index OOB, negative spacing, fractional count)
13. Spacing scales linearly with `typicalMoveDollars` (i.e. with σ)
14. Predictions are sorted ascending and the mean equals the anchor
15. Flat tape → spacing 0, every bot predicts the anchor

## Multi-account swarm (outcome-band pattern)

Trepa supports multiple wallets in one process via
[`trepa.bots.run` with a function argument](https://docs.trepa.io/developers/swarms#different-behaviour-per-bot).
The "outcome band" pattern has each bot predict a value shifted off a
shared fair anchor by `(index − (count−1)/2) · spacing`. The idea is
hedging: if you spread guesses across the plausible 30-second range,
at least one bot is close regardless of which way price moves.

`swarm.ts` reuses the same `forecast()` from `strategy.ts` as the band
**anchor**, and derives `spacing` from the same `typicalMove30sUSD`
the forecast already exposes:

```
anchor   = forecast(spot, samples).prediction
spacing  = bandSpacingFraction · typicalMove30sUSD     (default fraction = 0.5)
value[i] = anchor + (i − (count − 1) / 2) · spacing
```

This ties the band width to live volatility instead of a magic number.
A 5-bot swarm at the default fraction covers `±1.0` typical 30-second
moves around the anchor, which spans most of the round's outcome mass.

### Swarm dry-run

Print the band without any SDK or wallets — same audit-friendly mode:

```bash
node --experimental-strip-types --no-warnings swarm.ts --dry-run --count 5
# or equivalently, via the existing bot.ts entrypoint:
node --experimental-strip-types --no-warnings bot.ts --dry-run --swarm 5
```

Sample output (real, against live Coinbase data):

```json
{
  "spotUSD": 81083.555,
  "anchorUSD": 81078.713,
  "bandSpacingUSD": 9.684,
  "botCount": 5,
  "botPredictionsUSD": [
    81059.346, 81069.029, 81078.713, 81088.397, 81098.081
  ],
  "components": {
    "driftDollarsRaw": -24.616,
    "typicalMove30sUSD": 19.367,
    "capDollars": 4.842,
    "cappedNudgeUSD": -4.842,
    "sigmaPerSecond": 0.0000436,
    "sampleCount": 350,
    "bandSpacingFraction": 0.5
  }
}
```

Center bot is the regular `forecast()`. Bot 0 leans `−2·spacing` (the
"price will fall harder than my anchor" leg); bot 4 leans `+2·spacing`
(the "price will rip past my anchor" leg). The band is centered on the
anchor by construction, so the mean of `botPredictionsUSD` equals
`anchorUSD` to floating-point precision — a property the test suite
checks explicitly.

### Swarm production

Add one `{ TREPA_API_KEY_N, TREPA_PRIVATE_KEY_N }` pair per bot into
`.env` (Trepa requires one distinct Trepa account per bot — same-user
keys conflict on the "one prediction per pool per account" rule):

```bash
TREPA_API_KEY_1=trp_…
TREPA_PRIVATE_KEY_1=…
TREPA_API_KEY_2=trp_…
TREPA_PRIVATE_KEY_2=…
TREPA_API_KEY_3=trp_…
TREPA_PRIVATE_KEY_3=…

node --experimental-strip-types --no-warnings --env-file=.env swarm.ts
```

Swarm size is set by however many credential pairs `credentialsFromEnv()`
finds (it scans `_1`, `_2`, … until it hits a gap). Each bot's `predict`
receives its `{ index, count }` and places its value on the matching band
slot via `bandPosition(anchor, index, count, spacing)`.

### Why this is a defensible strategy

Two reasons it's worth running over a single-account bot, given Trepa's
math:

1. **At least one bot is close regardless of direction.** A 5-bot band
   covering `±1.0` typical moves around the vol-adjusted anchor catches
   the bulk of 30-second outcomes. The center bot is unchanged from the
   single-bot strategy, so you don't pay a quality tax on the anchor —
   the wings are bonus coverage on tail outcomes.
2. **`γ = 6` accuracy weight rewards the closest winner heavily.** Once
   you're guaranteed at least one bot inside the winning band, the
   payout to that bot is what matters, and `(1/(1+r))^6` rewards "I
   was the closest, by a lot" disproportionately. The wing bots cost
   you their entry fee on rounds where the anchor wins, but pay
   asymmetrically when the round runs out of your anchor's range.

The strategy is, of course, only as good as the `bandSpacingFraction`
calibration. Too tight and you waste accounts on near-duplicate guesses;
too wide and your wings lose more often than they win. Default 0.5 is
a starting point — tune from logged outcomes.

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
- **No reinforcement on outcome.** A real production bot would log
  every prediction and outcome, attribute its hits and misses, and
  tune `driftCapFraction`, `driftWindow`, and `bandSpacingFraction`
  automatically. Treat the defaults as a starting point, not a final
  answer.
- **No per-bot stake tuning in the swarm.** Every bot stakes
  `pool.min_stake` today. A natural next step is to stake more on the
  center bot (high-confidence anchor) and less on the wings
  (insurance), but that needs real outcome data to calibrate.

The point is to be a clean, honest baseline that you can fork and
improve. The pure-function shape of `forecast()` makes it trivial to
swap in any signal you trust more than mean-reversion-on-candles.

## License

MIT.
