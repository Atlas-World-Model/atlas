export type LootiRewardMode = "top_3" | "top_10";

export interface LootiCampaignBudget {
  amount: number;
  token: string;
  tokenAddress: string;
  tokenDecimals: number;
  usdValueAtCreation?: number;
}

export interface AtlasTreasuryFundingRequest {
  mode: "atlas_treasury_splits_v2";
  treasuryWalletAddress: string;
  maxSpendAmount: number;
  chainId: number;
}

export interface AtlasFundedSplit {
  mode: "atlas_treasury_splits_v2";
  splitAddress: string;
  splitCreationTxHash: string;
  fundingTxHash: string;
  splitType: "pull";
  controller: string;
}

export interface FundLootiSplitInput {
  idempotencyKey: string;
  treasuryPrivateKeyRef: string;
  tokenAddress: string;
  tokenDecimals: number;
  amount: number;
  controllerAddress: string;
}

export interface FundLootiSplitResult {
  mode: "atlas_treasury_splits_v2" | "manual" | "simulated";
  splitAddress?: string;
  splitCreationTxHash?: string;
  fundingTxHash?: string;
  splitType?: "pull";
  controller?: string;
}

export interface PrepareLootiCampaignInput {
  idempotencyKey: string;
  atlasRunId: string;
  promptCastHash: string;
  promptCastUrl?: string;
  creatorFid: number;
  creatorAddress: string;
  budget: LootiCampaignBudget;
  funding: AtlasTreasuryFundingRequest | AtlasFundedSplit | { mode: "manual" | "simulated" };
  rewardMode: LootiRewardMode;
  expiresAt: string;
  timezone: string;
  metadata?: Record<string, unknown>;
}

export interface PrepareLootiCampaignResult {
  requestId: string;
  status: "prepared" | "already_prepared";
  split: {
    splitAddress?: string;
    splitCreationTxHash?: string;
    splitType: "pull";
    controller: string;
    distributorFeePercent: 0;
    initialRecipients: Array<{
      address: string;
      percentAllocation: number;
    }>;
  };
  fundingInstruction: {
    tokenAddress: string;
    tokenDecimals: number;
    amount: number;
    amountInBaseUnits: string;
    recipientAddress: string;
    chainId: number;
  };
}

export interface CreateLootiCampaignInput extends PrepareLootiCampaignInput {
  preparedRequestId?: string;
  fundedSplit: AtlasFundedSplit;
}

export interface CreateLootiCampaignResult {
  campaignId: string;
  status: "active" | "already_active";
  targetCastHash: string;
  funding: AtlasFundedSplit;
}

export interface GetLootiCampaignResult {
  campaignId: string;
  status: string;
  targetCastHash: string;
  expiresAt: number;
  rewardMode: LootiRewardMode;
  rewardSetReady: boolean;
  split?: {
    splitAddress: string;
    fundingTxHash: string;
    splitType: "pull";
    controller: string;
  };
}

export interface LootiRewardSetEntry {
  fid: number;
  username: string;
  displayName?: string;
  rank: number;
  followerCount?: number;
  totalCompositeScore: number;
  totalLootiScore: number;
  topQuotes: Array<{
    hash: string;
    text: string;
    compositeScore: number;
    lootiScore: number;
    algoRank: number;
  }>;
}

export interface LootiRewardSet {
  campaignId: string;
  snapshotId: string;
  rewardSetLimit: 3 | 10;
  generatedAt: string;
  cast: {
    hash: string;
    text: string;
    authorUsername: string;
  };
  entries: LootiRewardSetEntry[];
  stats: {
    totalQuotes: number;
    filteredQuotes: number;
    leaderboardCount: number;
    spamCount: number;
  };
}

export interface AtlasPointAllocationInput {
  atlasRunId: string;
  rewardSetSnapshotId: string;
  allocations: Array<{
    fid: number;
    username: string;
    quoteHash: string;
    rank: number;
    points: number;
    rationale: string;
    memoryEffect?: {
      worldPath: string;
      summary: string;
    };
  }>;
}

export interface LootiClient {
  fundSplit?(input: FundLootiSplitInput): Promise<FundLootiSplitResult>;
  prepareCampaign(input: PrepareLootiCampaignInput): Promise<PrepareLootiCampaignResult>;
  createCampaign(input: CreateLootiCampaignInput): Promise<CreateLootiCampaignResult>;
  getCampaign(campaignId: string): Promise<GetLootiCampaignResult>;
  getRewardSet(campaignId: string, limit: 3 | 10): Promise<LootiRewardSet>;
  recordAtlasAllocations(campaignId: string, input: AtlasPointAllocationInput): Promise<void>;
}

export interface HttpLootiClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export class LootiApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "LootiApiError";
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.text();

  if (!response.ok) {
    throw new LootiApiError(
      `Looti API request failed with ${response.status}: ${body.slice(0, 300)}`,
      response.status,
      body
    );
  }

  return body ? (JSON.parse(body) as T) : (undefined as T);
}

export function createHttpLootiClient(options: HttpLootiClientOptions): LootiClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetcher = options.fetchImpl ?? fetch;

  const headers = (idempotencyKey?: string): HeadersInit => ({
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
  });

  return {
    async prepareCampaign(input) {
      const response = await fetcher(`${baseUrl}/api/atlas/campaigns/prepare`, {
        method: "POST",
        headers: headers(input.idempotencyKey),
        body: JSON.stringify(input),
      });

      return parseJsonResponse<PrepareLootiCampaignResult>(response);
    },

    async createCampaign(input) {
      const response = await fetcher(`${baseUrl}/api/atlas/campaigns`, {
        method: "POST",
        headers: headers(input.idempotencyKey),
        body: JSON.stringify(input),
      });

      return parseJsonResponse<CreateLootiCampaignResult>(response);
    },

    async getCampaign(campaignId) {
      const response = await fetcher(`${baseUrl}/api/atlas/campaigns/${encodeURIComponent(campaignId)}`, {
        method: "GET",
        headers: headers(),
      });

      return parseJsonResponse<GetLootiCampaignResult>(response);
    },

    async getRewardSet(campaignId, limit) {
      const response = await fetcher(
        `${baseUrl}/api/atlas/campaigns/${encodeURIComponent(campaignId)}/reward-set?limit=${limit}`,
        {
          method: "GET",
          headers: headers(),
        }
      );

      return parseJsonResponse<LootiRewardSet>(response);
    },

    async recordAtlasAllocations(campaignId, input) {
      const response = await fetcher(
        `${baseUrl}/api/atlas/campaigns/${encodeURIComponent(campaignId)}/atlas-allocations`,
        {
          method: "POST",
          headers: headers(),
          body: JSON.stringify(input),
        }
      );

      await parseJsonResponse<void>(response);
    },
  };
}
