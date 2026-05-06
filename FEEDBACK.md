# Feedback on the Jupiter Developer Platform integration

> Asked-for honesty. We integrated `lite-api.jup.ag` Swap V2 (quote +
> swap) into an autonomous bounty-earning agent. Here's what shipped
> well, what didn't, and the rough edges.

## What worked

- **Single `/quote` then `/swap` round trip is clean.** The model where
  you fetch a `QuoteResponse`, then pass that exact object back to
  `/swap`, is the right shape. It removes a whole class of "I assembled
  the wrong thing client-side" bugs that other aggregators have.
- **Route plan transparency.** Getting back the full
  `routePlan[].swapInfo` with `label`, `ammKey`, `inAmount`, `outAmount`,
  `feeAmount` per hop is the difference between trusting the quote and
  not. Many aggregators hide this.
- **Lite API works without an account.** Being able to *quote* before
  ever creating an API key is the right developer onboarding. Lowered
  time-to-first-call to seconds.
- **Slippage and direct-routes flags do what they say.** No surprises.

## What was confusing

- **Two API hosts to choose from.** `lite-api.jup.ag` vs the keyed
  `developers.jup.ag`. The docs imply lite is for testing and keyed is
  for prod, but the rate limits / quotas / pricing aren't obvious from
  the docs index. We had to dig to figure out we should be on the keyed
  endpoint for any agent that runs continuously.
- **`computeUnitPriceMicroLamports` vs `prioritizationFeeLamports`.** The
  swap endpoint accepts both. Both have an `'auto'` value. The
  interaction between them (do they add? does one override the other?)
  is not explained in the swap reference. We defaulted to neither and
  got working transactions; we don't yet know if that's leaving inclusion
  speed on the table.
- **`asLegacyTransaction` is undocumented in the lite API reference but
  works.** Found by reading the type definitions in the keyed API docs.
  Should be cross-linked.

## What we needed but didn't find

- **A `/quote/multi` endpoint.** Our use case (auto-rebalance N
  different won bounty payouts in one cycle) wants to ask for N quotes
  in one round trip. We fan-out N requests instead, which works but is
  noisier than it should be.
- **Decimals exposed on the quote.** We need the `decimals` of both
  input and output mints to convert between human-readable amounts and
  atomic units. Today we hardcode `6` for stables. The route plan has
  the mint addresses but not the decimals; our code has to either keep a
  static map (fragile) or hit a separate token-info endpoint (extra
  call). Including `inputDecimals` / `outputDecimals` on the
  `QuoteResponse` would remove a whole class of integration bugs.
- **A "minimum-meaningful" amount per route.** Sometimes a quote returns
  a route that, when you account for prioritization fee and slippage,
  nets less than the input. A precomputed `breakEvenInputAmount` would
  let agents skip swap attempts that don't make economic sense.

## Bugs / surprises

- **`priceImpactPct` is returned as a string, not a number.** Easy to
  parse, but it's the only numeric field that's a string in the
  response. Either keep it consistent with the rest of the response (all
  numeric) or document why it's a string (precision concerns?).
- **Empty routePlan on dust amounts.** If you ask for a quote on a tiny
  amount (e.g., 1000 atomic units), you sometimes get back a quote with
  a non-zero `outAmount` but an empty `routePlan`. We had to add an
  invariant that `routePlan.length > 0` before treating a quote as
  swappable.

## What this enabled in our project

This integration is the swap leg of an end-to-end loop:

1. Agent registers on Superteam Earn (their new agent program).
2. Agent submits work on `AGENT_ALLOWED` bounties.
3. When agent wins, sponsor pays in *their* preferred token.
4. **Our Jupiter integration** rebalances those payouts to the
   operator's working-capital token.
5. Operator's signer handles the actual on-chain submission.

The combination matters because the Superteam agent program does *not*
let the agent specify a payout token — sponsors pick. Without an
auto-rebalance layer, agents accumulate fragmented stables (USDC, USDG,
jupUSD) that a human has to manually consolidate every payout.

## Net

Jupiter's API is one of the cleanest swap APIs we've integrated against.
The friction we hit was mostly around discoverability of advanced
features (the prioritization fee story, the `asLegacyTransaction` flag)
and minor response-shape inconsistencies. Nothing blocking; everything
addressable in a docs pass.

The thing we'd most want to see next is `decimals` on `QuoteResponse`
and a batch-quote endpoint.
