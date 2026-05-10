/**
 * Local ambient declaration for @trepa/sdk.
 *
 * The package is intentionally an optional, lazy-imported peer in
 * `examples/trepa-bot/bot.ts` so that the dry-run path runs without it
 * installed. We only need its types when the production branch
 * compiles. The shape below mirrors the public SDK surface we use:
 * `credentialsFromEnv()` and `Trepa.bots.run`.
 *
 * Source: https://docs.trepa.io/developers/sdk-reference
 */

declare module '@trepa/sdk' {
  export interface AgentCredentials {
    apiKey: string;
    privateKey: string;
  }

  export function credentialsFromEnv(): AgentCredentials[];

  export interface PoolContext {
    /** Minimum stake in USDC base units accepted by the pool. */
    min_stake: number;
  }

  export interface PredictResult {
    /** The forecast value (e.g., BTC price in USD). */
    value: number;
    /** Stake size to commit to the prediction. */
    stake: number;
  }

  /**
   * Per-bot slot passed into the swarm factory. Mirrors the docs at
   * https://docs.trepa.io/developers/swarms#different-behaviour-per-bot.
   */
  export interface SwarmSlot {
    /** Zero-based bot index inside this swarm. */
    index: number;
    /** Total number of bots in this swarm. */
    count: number;
  }

  export interface BotsRunOptions {
    predict: (pool: PoolContext) => Promise<PredictResult> | PredictResult;
  }

  /**
   * Function form of `bots.run`: returns per-bot options keyed by slot.
   * Used for outcome-band swarms where each bot predicts a different value
   * around a shared anchor.
   */
  export type BotsRunFactory = (slot: SwarmSlot) => BotsRunOptions;

  export class Trepa {
    constructor(opts: { credentials: AgentCredentials[] });
    bots: {
      run: (opts: BotsRunOptions | BotsRunFactory) => Promise<void>;
    };
  }
}
