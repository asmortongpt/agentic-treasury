# Kimia Protocol — Twitter Thread (10 tweets)

> Source: [docs.kimia.live](https://docs.kimia.live). Six on-chain
> programs, real product surface. This thread mirrors what's actually
> in the docs — no marketing.

---

**1/** Most of "fixed-income on Solana" is a stablecoin in a box. @KimiaProtocol is the first stack I've seen that tries to do the *full* job — perps, delta-neutral yield, fixed-rate locks, principal/yield split, and a stablecoin — and ship them as composable on-chain programs. 🧵

**2/** The architecture is six Anchor programs, not one mega-monolith:
• `kimia-perp` — orderbook + funding + liquidation
• `delta-vault` — USDC → hedged SOL-PERP short
• `intent-router` — multi-step fixed-rate session
• `split-engine` — PT/YT splitter
• `yield-amm` — yield-space invariant pool
• `kusd-mint` — kUSD stablecoin

**3/** Start with the **delta vault**. You deposit USDC. The vault opens a hedged short on SOL-PERP, sized so your dollar exposure is roughly net zero. The yield isn't from price moves — it's from the funding rate paid by leveraged longs. Funding-rate yield without price exposure.

**4/** Now stack two things on top. First: **PT/YT tokenization**. The split-engine takes your vault shares and emits a Principal Token (claim on principal at maturity) and a Yield Token (claim on the variable yield until maturity). Both transferable. Both composable.

**5/** Second: the **yield-AMM**. PT/underlying pool with a yield-space invariant — prices move predictably toward par as maturity approaches. Trading PT *is* trading implied yield. That's how Pendle works on Ethereum; Kimia ships the same idea native to Solana.

**6/** Combine those two and you get the **intent-router**: a single session that routes USDC through the vault, splits to PT, and parks the PT until maturity — locking a *fixed APY* in three confirmed transactions. The user never has to assemble the legs by hand.

**7/** Underneath everything is **kUSD** — a multi-reserve-backed stablecoin with T+1 cross-stable swaps and staking yield. It's the unit of account for fees, settlement, and the staking layer that secures the whole system. Real backing, on-chain, auditable.

**8/** Risk is stated plainly in the docs. Funding can flip negative; the delta hedge isn't free; PT prices have term risk; oracles are Pyth Hermes pull (not push). Audits are listed. There's a bug bounty. None of this is hidden — that's already a higher bar than most "fixed-income" launches.

**9/** Why this matters for builders: the protocol exposes generated TypeScript clients (Codama-built from IDL), so you can integrate against any program without reimplementing instructions. Build a yield aggregator, a fixed-rate frontend, a PT-only secondary market — all with typed instruction calls.

**10/** Solana DeFi has been waiting for a credible fixed-income primitive set. @KimiaProtocol is the first one I've read where the whitepaper, the docs, and the code line up. Worth tracking. Devnet quickstart: docs.kimia.live/quickstart 🚀
