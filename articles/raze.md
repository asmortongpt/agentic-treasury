# Raze.bot: An open-source multi-wallet Solana trading stack

> One client, many wallets, no custodial signing — and a public API that
> exposes the on-chain forensics most retail trading bots keep behind
> their paywall.

## The thing that makes it weird

Most Solana "trading bots" aren't really for you. They run a custodial
backend, sign on your behalf, route order flow somewhere you can't
inspect, and surface you a chart and a Buy button. Raze.bot inverts
that model on every axis I care about.

The wallet keys live in your browser, encrypted with AES, generated
locally via `Keypair.generate()`, and never transmitted to any server.
Transaction signing happens client-side: deserialize the base58 tx,
sign with the local keypair, return signed bytes, broadcast. Their
[security audit doc](https://docs.raze.bot/solana-ui/security/audit)
spells it out — "private keys never leave the user's device."

The whole UI is open source at [`razedotbot/solana-ui`](https://github.com/razedotbot)
with one-click deploys to Vercel and Netlify. White-label support is
baked in: CSS variables, theme overrides, branding hooks. You can fork
it, brand it, and host your own version of Raze without asking anyone
permission. That's not how trading bots usually ship.

## Multi-wallet as a primitive, not a feature

Raze treats "wallet" as a plural. HD-derive a tree, import existing
keypairs, manage them in groups, fire a single trade across all of
them simultaneously. For a trader running a small fleet — splitting
exposure, testing strategies, or just refusing to put their entire
balance on one address — that's the difference between an actual tool
and a single-player PWA.

The implication: you can build "do this trade across these 12 wallets"
into a workflow without piecing together your own SDK plumbing. Raze's
backend APIs (powered by their own infra, per the docs) handle the
fan-out.

## The forensics engine nobody else exposes

Where Raze gets genuinely interesting is the
[history API](https://docs.raze.bot/api-reference/history/). It's the
kind of on-chain analytics that usually lives behind a $500/month
SaaS:

- **Funding ancestry** (`/funding/chain`) — given any wallet, walk back
  through who funded it, who funded that funder, up to N levels deep.
- **Bubblemap clustering** (`/funding/cluster`) — given a set of
  wallets, group them by shared funding ancestor. This is the same
  primitive that powers "did 50 of these holders all get SOL from the
  same dispenser?" sniper-farm detection.
- **Holder edge graph** (`/funding/holder-edges`) — direct user-to-user
  transfer edges among a wallet set, scoped to a mint, canonicalized
  and aggregated by pair. Drop in a token's top holders, get back the
  graph of who has been moving it to whom.
- **Reverse funding** (`/funding/funded-by`) — for any funder, list the
  wallets they've sent SOL to. Subtree expansion in one call.

If you've ever tried to build any of those primitives yourself against
RPC, you know what they cost in indexing time and storage. Raze
pre-builds them and exposes them over both REST and GraphQL.

There's also a perp-market layer that pulls OHLCV candles, open
interest series, market liquidations, and aggregated trigger orders
(currently for Jupiter Perps), and a sentiment / health time series
that gives you a chain-level signal you can correlate against your own
trades.

## Why this design beats the obvious alternative

A custodial trading bot has one structural advantage — convenience —
and three structural problems: it's a juicy target for hacks, it can
be subpoenaed, and it can rug your strategies into its own MEV pipe.

Raze trades a small amount of UX friction (you're managing your own
keys in the browser) for the disappearance of all three problems. The
keys aren't on a server, so there's nothing for an attacker to drain
in bulk. There's no "user fund pool" to subpoena. There's no
proprietary order-routing layer to skim from your fills. And because
the UI is open-source, you can audit any of that yourself rather than
trusting a marketing page.

For developers, the second-order win is bigger: the same APIs powering
the official UI are available to anyone with a key. Build a custom
front end, build a strategy engine, build a "wallet x token" forensic
dashboard — all the back-end heavy lifting is already done.

## What I'd want next

If I were writing the wishlist:

- **Webhook delivery for the funding-cluster events.** Right now you
  poll. For sniper-farm detection on new launches, latency matters.
- **A typed client SDK.** The REST + GraphQL surface is great, but a
  thin TS client with the schemas pre-baked would cut the time to
  first useful query by an hour.
- **Cross-chain funding ancestry.** Most farms are funded in a way
  that touches more than one chain. Solana-only ancestry is a real
  primitive but it's not the whole picture.

None of that is a complaint about what's there. It's a wishlist
because what's there is good enough to make a wishlist worthwhile —
that's the point.

## How to actually start

```
GitHub:   https://github.com/razedotbot
Docs:     https://docs.raze.bot
Discord:  https://discord.com/invite/RNK5v92XpB
Telegram: https://t.me/razesolana
```

Fork the UI, deploy your own to Vercel, point it at your wallets, and
in about ten minutes you've got an open-source trading frontend that
isn't holding your keys. Then start poking the history API. The
funding-cluster endpoint alone is worth the trip.
