/**
 * Treasury rebalancer — the "oh." piece.
 *
 * An AI agent earns bounties on Superteam in whatever token the sponsor
 * pays in (USDC, USDG, jupUSD). That's a fragmented stable-bag. The agent's
 * working capital should live in *one* token — typically jupUSD if it's
 * going to bid on more Jupiter-hosted bounties — to avoid manual
 * reconciliation by the human operator.
 *
 * This loop:
 *   1. Polls Superteam for any won submissions that have just been paid.
 *   2. For each payout in a non-target token, fetches a Jupiter quote.
 *   3. If price impact is acceptable, builds the swap transaction.
 *   4. Hands the transaction to the operator's signer (out of scope here —
 *      we deliberately do not hold keys).
 *
 * The combination is the point: Superteam's agent program issues payouts
 * to AI workers, but doesn't pick the token. Jupiter's swap aggregator
 * doesn't know about bounty payouts. Wired together, the agent earns and
 * compounds without human intervention. Neither team designed for this.
 */

import { JupiterClient, COMMON_MINTS, type QuoteResponse } from './jupiter.js';
import { SuperteamAgent, type SubmissionResult } from './superteam.js';

export interface RebalanceConfig {
  /** Mint address the operator wants final balance in. Default: jupUSD. */
  targetMint: string;
  /** Operator wallet that signs the resulting transaction. */
  operatorPublicKey: string;
  /** Reject swaps with worse price impact than this (as percent, e.g. 1.5 = 1.5%). */
  maxPriceImpactPct: number;
  /** Slippage tolerance on the swap, in bps. Default: 50 (0.5%). */
  slippageBps: number;
}

export interface RebalanceTask {
  submission: SubmissionResult;
  inputMint: string;
  inputAmount: bigint;
  quote: QuoteResponse;
  estimatedOut: bigint;
  priceImpactPct: number;
  /** Base64 signable transaction. Operator must sign+submit. */
  signableTransaction: string;
}

/**
 * Maps a sponsor's payout-token symbol to the SPL mint we'd quote
 * against. Symbols are normalized to lower-case at lookup time so
 * sponsors writing JUPUSD / jupUSD / JupUSD all resolve.
 */
const TOKEN_MINT_BY_NAME: Record<string, string> = {
  usdc: COMMON_MINTS.USDC,
  usdt: COMMON_MINTS.USDT,
  usdg: COMMON_MINTS.USDG,
  jupusd: COMMON_MINTS.JupUSD,
  jupsol: COMMON_MINTS.JupSOL,
  sol: COMMON_MINTS.SOL,
};

export class TreasuryRebalancer {
  constructor(
    private readonly superteam: SuperteamAgent,
    private readonly jupiter: JupiterClient,
    private readonly cfg: RebalanceConfig,
  ) {}

  /**
   * Inspects a list of known submissions and returns rebalance tasks for
   * any that have been paid in a non-target token. Idempotent — call as
   * often as you like; it only acts on `isPaid && status === 'Reviewed'`
   * submissions.
   */
  async planFromSubmissions(submissionIds: string[]): Promise<RebalanceTask[]> {
    const tasks: RebalanceTask[] = [];

    for (const id of submissionIds) {
      const sub = await this.superteam.submissionStatus(id);
      if (!sub.isPaid || !sub.isWinner) continue;

      // Token name lives in the listing, not the submission — we'd join on
      // listing here in real code. For demo we expose it from the listing
      // summary fetched separately.
      const tokenName = (sub as unknown as { paidToken?: string }).paidToken ?? 'USDC';
      const inputMint = TOKEN_MINT_BY_NAME[tokenName.toLowerCase()] ?? COMMON_MINTS.USDC;

      if (inputMint === this.cfg.targetMint) continue;

      // sub.rewardInUSD is USD value; we want atomic units of the input
      // token. For stables we assume 6 decimals (USDC/USDT/USDG/jupUSD all
      // 6). A production version would fetch the SPL mint's `decimals`.
      const inputAmount = BigInt(Math.floor(sub.rewardInUSD * 1_000_000));

      const quote = await this.jupiter.quote({
        inputMint,
        outputMint: this.cfg.targetMint,
        amount: inputAmount,
        slippageBps: this.cfg.slippageBps,
      });

      const priceImpact = parseFloat(quote.priceImpactPct);
      if (priceImpact > this.cfg.maxPriceImpactPct) {
        // Skip this round; price impact too high. Re-check next cycle.
        continue;
      }

      const swap = await this.jupiter.swap({
        userPublicKey: this.cfg.operatorPublicKey,
        quoteResponse: quote,
      });

      tasks.push({
        submission: sub,
        inputMint,
        inputAmount,
        quote,
        estimatedOut: BigInt(quote.outAmount),
        priceImpactPct: priceImpact,
        signableTransaction: swap.swapTransaction,
      });
    }

    return tasks;
  }
}
