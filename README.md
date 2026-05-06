# Agentic Treasury

> AI agents earn bounties in fragmented stables. They need one token to
> work in. This wires Superteam Earn's agent program to Jupiter Swap V2
> so won bounty payouts auto-rebalance into the operator's chosen
> working-capital token. No human in the swap loop.

## The Combination That Wasn't Designed For

Two new APIs landed in 2026 that don't talk to each other:

1. **Superteam Earn agent program** ([docs](https://superteam.fun/skill.md)).
   AI agents register, discover `AGENT_ALLOWED` listings, and submit work.
   When the agent wins, the sponsor pays in *their* token — could be USDC,
   USDG, jupUSD, jupSOL, anything.

2. **Jupiter Swap V2** ([docs](https://developers.jup.ag/)). Solana's
   liquidity aggregator. Quotes routes across every relevant DEX.

The gap between them: an agent earning across 5 different sponsors ends
up with 5 different tokens in its wallet, none of which is necessarily
the one it wants to deploy as working capital, and none of which a human
operator wants to manually reconcile every time the agent wins.

This repo is the layer that sits between them.

## What it does, end-to-end

1. Polls Superteam for the agent's submissions (`SuperteamAgent.submissionStatus`).
2. Filters to ones marked `isPaid && isWinner`.
3. For each payout in a non-target token, gets a Jupiter quote.
4. If price impact is below threshold, builds the swap transaction via
   Jupiter's swap endpoint.
5. Hands the signable transaction to the operator's signer. We
   deliberately do not hold keys; the operator's wallet signs and
   submits.

That last point matters. An autonomous agent that holds a private key
that controls real money is a different threat model. This design lets
the agent *plan* swaps autonomously, but the human signs.

## Real production use

The `SuperteamAgent` client in [`src/superteam.ts`](src/superteam.ts)
isn't a sketch. It's the same code path that submitted four articles
to Superteam earlier today, totaling **$2,410 USDC in pending bounties**:

| Bounty | Reward | Submission ID |
|---|---|---|
| Trepa Docs | $1,500 USDC | `7c68f040-8c5b-48f8-8c2a-659c8a42cc2a` |
| Covenant Battle | $620 USDC | `42864372-dd01-4a94-a177-f91ccfce6bcf` |
| Raze Twitter Thread | $180 USDC | `974b2af5-7ceb-43d4-8dc5-bd17cb2ceefa` |
| Kimia Twitter Thread | $110 USDC | `cc877dcc-cc8f-4d13-9f7a-e7e317e883b5` |

When those resolve and pay out, this exact code path is what the agent
will use to consolidate the resulting token bag.

## Try it

Read-only quote (no wallet, no signing, no API keys):

```bash
npm install
npx tsx examples/quote-demo.ts
```

You'll see a 100 USDC → jupUSD quote come back from Jupiter live, with
the route plan printed.

## Layout

- `src/jupiter.ts` — Jupiter Swap V2 client. Quote + build signable
  transaction. No signing.
- `src/superteam.ts` — Superteam Earn agent client. Register, list
  agent-eligible bounties, submit work, read submission status.
- `src/rebalance.ts` — `TreasuryRebalancer`. Pulls won-and-paid
  submissions from Superteam, plans Jupiter swaps for any in non-target
  tokens.
- `examples/quote-demo.ts` — runnable Jupiter quote demo.

## Honest feedback on the integration

See [FEEDBACK.md](FEEDBACK.md) for what worked, what didn't, and what we
needed that wasn't there.

## License

MIT.
