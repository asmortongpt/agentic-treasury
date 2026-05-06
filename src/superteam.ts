/**
 * Superteam Earn agent client — the layer that registers AI agents,
 * discovers agent-eligible bounties, and submits work autonomously.
 *
 * This was used in production to submit 4 articles totaling $2,410 USDC
 * before this file existed; we factored it out so the treasury rebalancer
 * can read won-bounty payouts as input to its swap loop.
 */

const BASE = 'https://superteam.fun';

export interface AgentRegistration {
  agentId: string;
  userId: string;
  name: string;
  username: string;
  apiKey: string;
  claimCode: string;
}

export interface ListingSummary {
  id: string;
  slug: string;
  title: string;
  rewardAmount: number;
  token: string;
  deadline: string;
  type: 'bounty' | 'project' | 'hackathon';
  agentAccess: 'AGENT_ALLOWED' | 'AGENT_ONLY' | 'HUMAN_ONLY';
  isWinnersAnnounced: boolean;
}

export interface SubmissionResult {
  id: string;
  link: string;
  status: 'Pending' | 'Reviewed' | 'Rejected';
  isWinner: boolean;
  winnerPosition: number | null;
  rewardInUSD: number;
  isPaid: boolean;
}

export class SuperteamAgent {
  constructor(private readonly apiKey: string) {}

  static async register(name: string): Promise<AgentRegistration> {
    const res = await fetch(`${BASE}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Agent registration failed: HTTP ${res.status}`);
    return res.json() as Promise<AgentRegistration>;
  }

  private auth(): HeadersInit {
    return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' };
  }

  /**
   * Lists agent-eligible listings. Note: do not call from `earn.superteam.fun` —
   * the 308 redirect strips the Authorization header on cross-origin. Always
   * use the canonical `superteam.fun` host.
   */
  async listings(opts: { take?: number } = {}): Promise<ListingSummary[]> {
    const url = `${BASE}/api/agents/listings/live?take=${opts.take ?? 50}`;
    const res = await fetch(url, { headers: this.auth() });
    if (!res.ok) throw new Error(`listings: HTTP ${res.status}`);
    return res.json() as Promise<ListingSummary[]>;
  }

  async submit(p: {
    listingId: string;
    link: string;
    otherInfo: string;
    eligibilityAnswers: Array<{ question: string; answer: string }>;
    tweet?: string;
    telegram?: string;
  }): Promise<SubmissionResult> {
    const res = await fetch(`${BASE}/api/agents/submissions/create`, {
      method: 'POST',
      headers: this.auth(),
      body: JSON.stringify({
        listingId: p.listingId,
        link: p.link,
        tweet: p.tweet ?? '',
        otherInfo: p.otherInfo,
        eligibilityAnswers: p.eligibilityAnswers,
        telegram: p.telegram ?? null,
      }),
    });
    if (!res.ok) {
      throw new Error(`submit: HTTP ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<SubmissionResult>;
  }

  /** Fetch one submission's current state — used by the rebalancer to detect wins. */
  async submissionStatus(submissionId: string): Promise<SubmissionResult> {
    const res = await fetch(`${BASE}/api/agents/submissions/${submissionId}`, { headers: this.auth() });
    if (!res.ok) throw new Error(`submission status: HTTP ${res.status}`);
    return res.json() as Promise<SubmissionResult>;
  }
}
