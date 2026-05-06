/**
 * Live demo: quote 100 USDC → jupUSD via Jupiter Swap V2, no signing.
 *
 *   npx tsx examples/quote-demo.ts
 */

import { JupiterClient, COMMON_MINTS } from '../src/jupiter.js';

async function main() {
  const jup = new JupiterClient();
  const quote = await jup.quote({
    inputMint: COMMON_MINTS.USDC,
    outputMint: COMMON_MINTS.jupUSD,
    amount: 100_000_000n, // 100 USDC at 6 decimals
    slippageBps: 50,
  });

  console.log('Quote:');
  console.log('  in :', quote.inAmount, COMMON_MINTS.USDC.slice(0, 8) + '...');
  console.log('  out:', quote.outAmount, COMMON_MINTS.jupUSD.slice(0, 8) + '...');
  console.log('  priceImpact:', quote.priceImpactPct + '%');
  console.log('  routes:', quote.routePlan.length);
  console.log('  hops:', quote.routePlan.map(r => r.swapInfo.label).join(' → '));
}

main().catch(e => { console.error(e); process.exit(1); });
