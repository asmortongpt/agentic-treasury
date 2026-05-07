# Trepa Flash Pools: Why Median-Error Beats Yes/No Betting

> A walk through how Trepa actually scores forecasts, why the math is
> different from binary prediction markets, and what it implies for
> anyone building automated forecasters on Solana.

## The opinion that mattered

Polymarket-style binaries ask the wrong question for short horizons.
"Will BTC be over X in 60 seconds" loses information. Two traders who
both said "yes" get the same payout whether one was inside a dollar of
the truth and the other was a thousand dollars away. At one-minute
resolution that's not a market — it's a coin flip with extra steps.

Trepa starts from the opposite premise: rank forecasts by closeness,
not by side, and pay accuracy proportional to how close you got.
Everything else in the design follows from that.

## What a round actually looks like

A Bitcoin Flash Pool round is exactly 60 seconds:

- **Forecasting window — 30 seconds.** You drag a slider next to a live
  BTC chart and submit a price estimate. Everyone pays the same fixed
  entry fee — currently **$1 USDC**.
- **Resolution window — 30 seconds.** No more entries. The settlement
  price is the BTC price at the end of this window, built from Binance
  BTC/USDT trade data.
- **Settlement.** The protocol resolves on-chain, picks winners, pays
  out, and starts the next round immediately.

USDC is the only token you need. Trepa covers the Solana network fees
for in-app activity, so your wallet doesn't have to hold SOL.

## How the protocol picks winners

This is where Trepa diverges from every "prediction market" you've used.

For each player `i`:

```
estimate    x_i   ← your number
outcome     y     ← the settled BTC price
error       e_i   = |x_i − y|
median      m     = median of all e_i this round
```

The **median-error rule**: your round is a win if `e_i ≤ m`. In a
typical pool, about half the field wins before any skill premium kicks
in. Ties at the cutoff and other corner cases fall under the
"best-coalition exception," which keeps the rule honest when many
players land on the same number.

Compare that to a binary market. There you commit to a side; you're
either right or you're not, and the market price is what's noisy. Trepa
moves the noise into how *close* you are, which is a richer signal at
short horizons.

## Where the prize money actually comes from

Losers' entry fees fund the prize pool, minus the platform take. Then
two formulas decide what each winner takes home:

**1. Accuracy weight** — among winners, closer forecasts get a steeper
share of the pool. Trepa's published formula is:

```
r_i = e_i / m                       (your error vs the median)
a_i = ( 1 / (1 + r_i) ) ^ γ         (γ = 6 currently)
```

That γ = 6 exponent is the punchline. A small edge over the median
becomes a meaningful share of the pool. Cut your error in half and your
weight goes from 1 to roughly 64.

**2. Capped proportional payout.** Without a ceiling, a single very
close call could swallow the whole pool when a round is sparse. Trepa
caps each winner's profit at **100× their entry fee** — for a $1 entry,
$100 max profit per round. Anything above the cap is reallocated to
the other winners (water-filling), not skimmed by the house.

The full payout for a winner is:

```
gain_i  = min( α · a_i , cap_i )    cap_i = entry_fee × 100
payout  = entry_fee + gain_i
```

`α` is one global scalar chosen so the gains sum exactly to the
dividend pool while no one exceeds their cap. Think of it as
water-filling: assign by weight, hit caps, redistribute residual,
repeat.

## Precision Score: the part that isn't about money

Each round you also get a **Precision Score** between 100 and 1000.
This is *not* used for payouts. It exists to power streaks and
leaderboards, and it's calibrated against recent BTC volatility so the
number means the same thing in calm and chaotic markets:

```
ε_i = | ln(x_i) − ln(y) |                  (log-return error)
λ   = ln(2) / σ                            (σ = stddev of recent 1-min log returns)
PS_i = max( 100 , 1000 · exp(−λ · ε_i) )
```

In English: a 500 means you were one typical 1-minute move off. 700 is
about half a typical move off. 1000 is perfect. Each additional unit of
typical error roughly halves your score down to a 100 floor. Volatility
calibration anchors this; in calm markets, the same dollar error scores
slightly worse, in volatile markets slightly better.

Streaks are runs of consecutive rounds with `PS > 777`. Hit a
qualifying streak and you trigger a payout from the **accumulator pool**
— half goes to the achievers, half rolls forward. The pool always holds
at least $100 and has no upper bound. Crucially: streaks are
independent of winning the round. You can extend a streak on a losing
round, or win without extending the streak.

## What this design implies for builders

Two things stand out if you're building software that participates in
Trepa rather than playing it manually.

**One — the SDK supports automation.** Trepa publishes
`@trepa/sdk` with first-class APIs for placing predictions, managing
sessions via API keys, and running multi-account "swarms" from a single
process (`trepa.bots.run` with hooks and shutdown). The whole transaction
flow is two-step: build an unsigned transaction via the API, sign with
your exported wallet key, submit. No custodial signing, no third-party
keepers.

A working baseline bot lives at
[`examples/trepa-bot/`](../examples/trepa-bot/) in this repo —
pure-function strategy, six unit tests, dry-run mode that produces a
real forecast against live Coinbase candles without ever needing a
Trepa API key. The output is auditable: every component (drift, σ,
typical 30-second move, cap, post-cap nudge) appears in the JSON, so a
reviewer can sanity-check that the bot is not doing anything strange
before they hand it real keys.

**Two — the math rewards bots that *don't* try to be heroes.** A naive
bot that just predicts the mid will beat the median often enough to
clear win-rate. The hard work — and the γ = 6 exponent — favors models
that find a small consistent edge: prefer mean-reversion in the calmest
half of the volatility window, prefer momentum in the noisier half, lean
on order-book imbalance in the last second of the forecasting window.
You don't need to be right by a lot; you need to be closer than the
median by a little, repeatedly.

This is a fundamentally different shape than binary markets, where
every dollar of bot capital fights for a yes/no edge that often
collapses to coin flips at one-minute horizons. Trepa's curve gives
real headroom to incremental skill.

## The honest part

Two things to flag if you're shopping for short-horizon prediction
products:

- **Trepa is BTC-first today.** The settlement source is Binance
  BTC/USDT trade data. If you wanted to bet on something else
  one-minute-out, you can't — yet. The mechanics generalize to any
  numerical asset, but the rounds available now are BTC.
- **The 100× cap is a tuning knob.** It's deliberately set to keep
  rounds from being decided by single outliers, but it does mean a
  perfectly-placed forecast in a sparse round caps out at a fixed
  multiple of entry. Whales looking for unbounded asymmetric upside
  won't find it here. That's a feature, not a bug.

If you've built models that produce calibrated point estimates rather
than directional calls — even modestly skilled ones — Trepa is the
first venue I've seen on Solana that pays you proportional to the
calibration. The math at the core (accuracy weight with γ = 6, 100×
cap, log-return Precision Score) makes that explicit, which means it's
also auditable. Read the docs and the formulas line up with what gets
paid on-chain.

Trepa is at [trepa.app](https://trepa.app); docs are at
[docs.trepa.io](https://docs.trepa.io). The team is backed by
[Colosseum](https://colosseum.com/) and Balaji Srinivasan.
