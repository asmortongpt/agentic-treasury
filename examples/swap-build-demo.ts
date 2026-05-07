/**
 * Live demo: full quote -> swap pipeline. Returns a signable
 * VersionedTransaction. We do NOT sign or submit; the operator's
 * signer would do that.
 *
 *   node --experimental-strip-types --no-warnings examples/swap-build-demo.ts
 *
 * Why this is here: the rebalancer's value depends on actually being
 * able to construct a swap transaction, not just a quote. This demo
 * proves the second leg works end-to-end with a real (unfunded)
 * pubkey, real liquidity, real route.
 */

const QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const SWAP = 'https://lite-api.jup.ag/swap/v1/swap';

// System Program — a real 32-byte pubkey, no associated funds. Used here
// only to make Jupiter happy with the userPublicKey field. We're not
// signing or submitting, so the wallet identity doesn't matter.
const DEMO_USER = '11111111111111111111111111111111';

// 10 USDC -> jupSoL. ATA accounts that don't exist would normally be
// created by the swap; that's expected and visible in the route plan.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const JUP_SOL = 'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v';

async function main(): Promise<void> {
  // 1. Get a quote.
  const qRes = await fetch(`${QUOTE}?inputMint=${USDC}&outputMint=${JUP_SOL}&amount=10000000&slippageBps=50`);
  if (!qRes.ok) throw new Error(`quote: HTTP ${qRes.status}`);
  const quote = await qRes.json() as Record<string, unknown>;
  console.log('=== QUOTE ===');
  console.log('inAmount    :', quote['inAmount'], '(10 USDC)');
  console.log('outAmount   :', quote['outAmount']);
  console.log('priceImpact :', quote['priceImpactPct'] + '%');
  const routePlan = quote['routePlan'] as Array<{ swapInfo: { label: string } }>;
  console.log('hops        :', routePlan.map(r => r.swapInfo.label).join(' -> '));

  // 2. Build the swap.
  const sRes = await fetch(SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPublicKey: DEMO_USER, quoteResponse: quote }),
  });
  if (!sRes.ok) throw new Error(`swap build: HTTP ${sRes.status} ${await sRes.text()}`);
  const swap = await sRes.json() as { swapTransaction: string; lastValidBlockHeight: number; prioritizationFeeLamports: number };

  console.log();
  console.log('=== SWAP TRANSACTION ===');
  console.log('swapTransaction len :', swap.swapTransaction.length, 'chars (base64)');
  console.log('lastValidBlockHeight:', swap.lastValidBlockHeight);
  console.log('prioritizationFee   :', swap.prioritizationFeeLamports, 'lamports');
  console.log();
  console.log('OK — signable transaction returned. Operator signer would deserialize,');
  console.log('sign with their keypair, and submit via web3.Connection.sendTransaction.');
}

main().catch(e => { console.error(e); process.exit(1); });
