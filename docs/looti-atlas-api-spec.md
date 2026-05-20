# Looti Atlas API Spec

This spec is the implementation handoff for adding Atlas campaign support to
Looti.

Atlas is the autonomous campaign initiator. Looti remains the campaign, ranking,
and distribution system. Atlas should not write Looti Firestore documents
directly.

## Goal

Enable Atlas to:

1. Publish a Farcaster prompt cast.
2. Create a Looti quote campaign for that cast.
3. Fund the Split-backed campaign contract from the Atlas treasury wallet.
4. Let Looti rank quotes and distribute the campaign budget through its existing
   Splits V2 flow.
5. Fetch the final reward set for Atlas memory updates and point allocation.

## Non-Goals

- Atlas does not rank all Farcaster replies itself.
- Atlas does not ingest mentions, replies, or ambient discussion as canonical
  input.
- Atlas does not bypass Looti's campaign/distribution lifecycle.
- Looti should not need Atlas's agent memory or world files.

## Auth

All Atlas endpoints should require:

```http
Authorization: Bearer $ATLAS_LOOTI_API_KEY
Idempotency-Key: <stable atlas campaign key>
```

Reject missing or invalid auth with `401`.

Reject missing idempotency key with `400`.

Every endpoint that can create a campaign or touch funding metadata must be
idempotent. The idempotency key should be stored on the campaign document or in a
small `atlasCampaignRequests` collection before any durable side effect.

## Funding Model

Production mode is:

```ts
type FundingMode = "atlas_treasury_splits_v2";
```

Atlas owns the treasury wallet and funds the Split-backed campaign contract.
Looti owns the campaign API and campaign records.

The Splits CLI package is:

```bash
npm install -g @splits/splits-cli
```

The CLI can be used by Atlas's VPS/agent harness if it is simpler than the SDK.
Do not assume the CLI can run inside an edge runtime. Wallet operations should
run in a normal Node process or long-running worker with secrets, logs,
idempotency, and spend ceilings.

## Recommended V0 Flow

Use a two-phase flow. It keeps Atlas treasury signing out of Looti.

### Phase 1: Prepare Campaign

`POST /api/atlas/campaigns/prepare`

Looti validates the request and returns the Split parameters Atlas needs to fund.
Looti may either create the Pull Split itself or return enough canonical
parameters for Atlas to create a Looti-compatible Pull Split.

Request:

```ts
type PrepareAtlasCampaignRequest = {
  idempotencyKey: string;
  atlasRunId: string;
  promptCastHash: string;
  promptCastUrl?: string;
  creatorFid: number;
  creatorAddress: string;
  rewardMode: "top_3" | "top_10";
  budget: {
    amount: number;
    token: string;
    tokenAddress: string;
    tokenDecimals: number;
    usdValueAtCreation?: number;
  };
  funding: {
    mode: "atlas_treasury_splits_v2";
    treasuryWalletAddress: string;
    maxSpendAmount: number;
    chainId: number;
  };
  expiresAt: string;
  timezone: string;
  metadata?: Record<string, unknown>;
};
```

Response:

```ts
type PrepareAtlasCampaignResult = {
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
};
```

Validation:

- `budget.amount > 0`
- `budget.amount <= funding.maxSpendAmount`
- `rewardMode` maps to Looti distribution algorithm:
  - `top_3` -> `the_ladder`
  - `top_10` -> `the_well`
- `promptCastHash` exists and is a cast hash.
- `creatorFid` is positive.
- `expiresAt` is in the future.
- `funding.chainId` matches the supported deployment chain.

### Phase 2: Activate Campaign

`POST /api/atlas/campaigns`

Atlas calls this after funding the Split-backed contract.

Request:

```ts
type CreateAtlasCampaignRequest = PrepareAtlasCampaignRequest & {
  preparedRequestId?: string;
  fundedSplit: {
    mode: "atlas_treasury_splits_v2";
    splitAddress: string;
    splitCreationTxHash: string;
    fundingTxHash: string;
    splitType: "pull";
    controller: string;
  };
};
```

Response:

```ts
type CreateAtlasCampaignResult = {
  campaignId: string;
  status: "active" | "already_active";
  targetCastHash: string;
  funding: {
    mode: "atlas_treasury_splits_v2";
    splitAddress: string;
    splitCreationTxHash: string;
    fundingTxHash: string;
    splitType: "pull";
    controller: string;
  };
};
```

Activation requirements:

- Verify `fundedSplit.splitAddress` is present.
- Verify `fundedSplit.fundingTxHash` is present.
- Prefer verifying the Split token balance is at least the budget amount before
  creating an active campaign.
- Reuse the existing Looti campaign document shape so current cron/distribution
  jobs continue to work.

## Firestore Campaign Shape

Create a document in `campaigns/{campaignId}` compatible with the existing
Looti app and functions.

Required fields:

```ts
type AtlasLootiCampaignDocument = {
  name: string;
  type: "quote_campaign";
  targetCast: {
    hash: string;
    authorFid: number;
    authorUsername: string;
  };
  budget: {
    amount: number;
    token: string;
    tokenAddress: string;
    tokenDecimals: number;
    usdValueAtCreation: number;
  };
  expiresAt: number;
  timezone: string;
  distribution: {
    type: "quotes_only";
    algorithm: "the_ladder" | "the_well";
    totalBudget: number;
  };
  creatorFid: number;
  creatorAddress: string;
  status: "active";
  createdAt: FirebaseFirestore.FieldValue;
  updatedAt: FirebaseFirestore.FieldValue;
  split: {
    splitAddress: string;
    fundingTxHash: string;
    splitCreationTxHash: string;
    splitType: "pull";
    controller: string;
  };
  source: {
    system: "atlas";
    atlasRunId: string;
    idempotencyKey: string;
  };
};
```

Notes:

- `expiresAt` should match Looti's existing millisecond timestamp convention.
- `distribution.algorithm` must be `the_ladder` for top 3 campaigns and
  `the_well` for top 10 campaigns.
- `split.splitAddress` and `budget.tokenAddress` are required by
  `functions/distributeSplit.js`.
- Current Looti code uses the backend/controller address as the temporary 100%
  Split recipient before winners are calculated.

## Get Campaign

`GET /api/atlas/campaigns/:campaignId`

Return campaign status, expiration, target cast, budget, distribution algorithm,
Split metadata, and whether the reward set is ready.

Response:

```ts
type GetAtlasCampaignResult = {
  campaignId: string;
  status: string;
  targetCastHash: string;
  expiresAt: number;
  rewardMode: "top_3" | "top_10";
  rewardSetReady: boolean;
  split?: {
    splitAddress: string;
    fundingTxHash: string;
    splitType: "pull";
    controller: string;
  };
};
```

## Get Reward Set

`GET /api/atlas/campaigns/:campaignId/reward-set?limit=3|10`

This should return a frozen or reproducible snapshot of the Looti-ranked
responses. Atlas will only review this set as canonical public input.

Response:

```ts
type LootiRewardSet = {
  campaignId: string;
  snapshotId: string;
  rewardSetLimit: 3 | 10;
  generatedAt: string;
  cast: {
    hash: string;
    text: string;
    authorUsername: string;
  };
  entries: Array<{
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
  }>;
  stats: {
    totalQuotes: number;
    filteredQuotes: number;
    leaderboardCount: number;
    spamCount: number;
  };
};
```

Implementation options:

- Prefer reading the already-saved winner/snapshot data from Firestore after
  campaign processing.
- If no snapshot exists, call the existing `/api/algo-quotes` path with
  `hash`, `creatorFid`, `minFollowers`, and `campaignId`, then freeze the
  returned result before responding.

## Record Atlas Allocations

`POST /api/atlas/campaigns/:campaignId/atlas-allocations`

Atlas allocations are separate from Looti's base payout ranking. They record how
Atlas used the reward set for memory and reputation.

Request:

```ts
type AtlasPointAllocationInput = {
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
};
```

Store under:

```text
campaigns/{campaignId}/atlasAllocations/{atlasRunId}
```

## Tests

Minimum tests for the Looti implementation:

- rejects unauthenticated Atlas requests
- rejects missing idempotency key
- rejects budget above `maxSpendAmount`
- maps `top_3` to `the_ladder`
- maps `top_10` to `the_well`
- creates Firestore campaign document with required `split` metadata
- repeated create call with same idempotency key returns the same campaign
- reward set endpoint returns only requested top 3 or top 10 entries
- allocation endpoint stores Atlas rationales without changing Looti payouts

## Environment

Looti:

```bash
ATLAS_LOOTI_API_KEY=
LOOTI_BACKEND_ADDRESS=
```

Atlas:

```bash
ATLAS_LOOTI_API_BASE_URL=https://looti.club
ATLAS_LOOTI_API_KEY=
ATLAS_TREASURY_WALLET_ADDRESS=
ATLAS_TREASURY_PRIVATE_KEY=
```

Use `ATLAS_TREASURY_PRIVATE_KEY` only in the Atlas VPS/agent harness or another
explicit treasury runtime. Do not expose it to browser code.
