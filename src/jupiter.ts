/**
 * Jupiter Swap V2 client — minimal, typed, production-grade.
 *
 * Used by the Agentic Treasury to autonomously rebalance bounty payouts
 * (USDC, jupUSD, USDG) into the operator's preferred working capital token.
 */

const JUP_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP = 'https://lite-api.jup.ag/swap/v1/swap';

export interface QuoteParams {
  inputMint: string;          // SPL mint address of token in
  outputMint: string;         // SPL mint address of token out
  amount: bigint | number;    // Atomic units of inputMint
  slippageBps?: number;       // Default 50 (0.5%)
  onlyDirectRoutes?: boolean; // Default false; true = single-hop only
  asLegacyTransaction?: boolean;
}

export interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: { ammKey: string; label: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; feeAmount: string; feeMint: string };
    percent: number;
  }>;
  contextSlot: number;
  timeTaken: number;
}

export interface SwapParams {
  userPublicKey: string;
  quoteResponse: QuoteResponse;
  wrapAndUnwrapSol?: boolean;
  computeUnitPriceMicroLamports?: number | 'auto';
  prioritizationFeeLamports?: number | 'auto';
}

export interface SwapResponse {
  swapTransaction: string;     // Base64-serialized VersionedTransaction
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
}

export class JupiterClient {
  private readonly apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey;
  }

  private headers(): HeadersInit {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  }

  /**
   * Fetch a swap quote. The returned `QuoteResponse` is what you pass to
   * `swap()` — never reconstruct it client-side; signing depends on its
   * exact fields including `contextSlot`.
   */
  async quote(p: QuoteParams): Promise<QuoteResponse> {
    const params = new URLSearchParams({
      inputMint: p.inputMint,
      outputMint: p.outputMint,
      amount: String(p.amount),
      slippageBps: String(p.slippageBps ?? 50),
      onlyDirectRoutes: String(p.onlyDirectRoutes ?? false),
    });
    if (p.asLegacyTransaction) params.set('asLegacyTransaction', 'true');

    const res = await fetch(`${JUP_QUOTE}?${params.toString()}`, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Jupiter quote failed: HTTP ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<QuoteResponse>;
  }

  /**
   * Build a signable swap transaction from a fresh quote. Caller signs and
   * submits. We deliberately do not handle signing here — the agentic
   * treasury layer holds the keypair.
   */
  async swap(p: SwapParams): Promise<SwapResponse> {
    const body: Record<string, unknown> = {
      userPublicKey: p.userPublicKey,
      quoteResponse: p.quoteResponse,
      wrapAndUnwrapSol: p.wrapAndUnwrapSol ?? true,
    };
    if (p.computeUnitPriceMicroLamports !== undefined) body['computeUnitPriceMicroLamports'] = p.computeUnitPriceMicroLamports;
    if (p.prioritizationFeeLamports !== undefined) body['prioritizationFeeLamports'] = p.prioritizationFeeLamports;

    const res = await fetch(JUP_SWAP, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Jupiter swap build failed: HTTP ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<SwapResponse>;
  }
}

export const COMMON_MINTS = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  jupUSD: 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v',
  USDG: 'USDGAhRR9w8RmYdNPp7yZdfzssJoYqJxBMoxBXPgCrk',
  SOL: 'So11111111111111111111111111111111111111112',
} as const;
