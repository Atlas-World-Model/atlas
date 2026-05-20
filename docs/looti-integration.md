# Looti Integration

Atlas uses Looti as its campaign, ranking, and reward-set boundary.

Implementation handoff: [Looti Atlas API Spec](./looti-atlas-api-spec.md).

Atlas does not rank all Farcaster responses itself. Atlas asks public questions,
funds Looti campaigns, waits for Looti to rank quote responses, then reviews only
the campaign reward set.

## V0 Boundary

Canonical public input enters Atlas through Looti campaign reward sets only.

- Atlas may cast campaign prompts and thread context.
- Atlas may announce campaign results and memory updates.
- Atlas does not ingest mentions, replies, or ambient Farcaster discussion as
  canonical memory.
- Atlas reviews only the top 3 or top 10 ranked responses returned by Looti.

## Campaign Brief Format

Atlas publishes a simple first cast, then a short thread with the reasoning.

### Cast 1: Simple Prompt

The first cast should be plain and answerable without reading the full thread.

Template:

```text
I need to understand {problem in one sentence}.

{question}

Quote this with {evidence requested in plain language}. @looti will rank responses,
and I will update my memory from the top {3|10}.
```

### Thread: Inquiry Brief

The thread can expose Atlas's reasoning.

1. Problem
2. Current belief
3. Useful evidence
4. How results will be used
5. Reward boundary

Example:

```text
Problem:

Useful conversations disappear unless someone turns them into durable context.

I am trying to learn what makes that conversion actually work.
```

```text
Current belief:

People contribute better when they can see how their answer may change the shared
record.
```

```text
Useful answers include:

examples
failure cases
tools
rituals
incentives
metrics

Specifics are better than principles.
```

```text
How I will use this:

@looti ranks the quote responses.

I review the top 10.

Winning responses may update my world-state, entity registry, or next campaign.
```

## Programmatic API Needed

Atlas needs a typed server-to-server Looti API. Regex commands may be useful for
operator ergonomics later, but the product boundary should be typed calls.

The production path should be Atlas-initiated campaign creation through a
Looti-owned API. Atlas should not write Firestore campaign records directly and
should not rely on browser wallet flows. Atlas requests a campaign, funds the
Split-backed campaign contract from its treasury, and Looti records the durable
campaign/funding metadata.

### Create Campaign

`POST /api/atlas/campaigns`

Auth:

- `Authorization: Bearer $ATLAS_LOOTI_API_KEY`
- `Idempotency-Key: <atlas-run-or-campaign-key>`

Input:

```ts
type CreateLootiCampaignInput = {
  idempotencyKey: string;
  atlasRunId: string;
  promptCastHash: string;
  promptCastUrl?: string;
  creatorFid: number;
  creatorAddress: string;
  budget: {
    amount: number;
    token: string;
    tokenAddress: string;
    tokenDecimals: number;
    usdValueAtCreation?: number;
  };
  funding:
    | {
        mode: "atlas_treasury_splits_v2";
        treasuryWalletAddress: string;
        maxSpendAmount: number;
        chainId: number;
      }
    | {
        mode: "atlas_treasury_splits_v2";
        splitAddress: string;
        splitCreationTxHash: string;
        fundingTxHash: string;
        splitType: "pull";
        controller: string;
      }
    | {
        mode: "manual" | "simulated";
      };
  rewardMode: "top_3" | "top_10";
  expiresAt: string;
  timezone: string;
  metadata?: Record<string, unknown>;
};
```

Output:

```ts
type CreateLootiCampaignResult = {
  campaignId: string;
  status: "active" | "pending_funding" | "failed";
  targetCastHash: string;
  funding?: {
    mode: "atlas_treasury_splits_v2" | "manual" | "simulated";
    txHash?: string;
    splitAddress?: string;
    splitCreationTxHash?: string;
    splitType?: "pull";
    controller?: string;
  };
};
```

Server behavior:

1. Authenticate Atlas.
2. Enforce idempotency before any onchain action.
3. Validate budget, token, expiration, target cast, and reward mode.
4. For `atlas_treasury_splits_v2`, create or prepare a Pull Split compatible
   with Looti distribution.
5. Confirm the Split is funded by Atlas treasury before activation.
6. Write the Looti campaign record with Split metadata.
7. Return the campaign ID and transaction metadata.

The endpoint should reject a request when `budget.amount > funding.maxSpendAmount`.
This gives Atlas a declarative spend ceiling per campaign even if its prompt or
run state is wrong.

Implementation can be one-phase or two-phase:

- One-phase: Atlas worker calls the Looti endpoint, creates/funds the Split
  through its local treasury adapter, and the endpoint records the funded
  campaign before responding.
- Two-phase: Atlas asks Looti for Split/campaign parameters, funds the Split,
  then calls the same endpoint with funded Split metadata.

### Get Campaign

`GET /api/atlas/campaigns/:campaignId`

Atlas needs status, expiration, budget, target cast, algorithm, and whether the
reward set is ready.

### Get Reward Set

`GET /api/atlas/campaigns/:campaignId/reward-set?limit=3|10`

Output:

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
  entries: LootiRewardSetEntry[];
  stats: {
    totalQuotes: number;
    filteredQuotes: number;
    leaderboardCount: number;
    spamCount: number;
  };
};
```

### Record Atlas Allocations

Atlas allocations are separate from Looti's base payout ranking.

`POST /api/atlas/campaigns/:campaignId/atlas-allocations`

Input:

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

## Funding Decision

Looti already uses Splits.org V2 Pull Splits.

Current Looti flow:

1. Creator wallet creates a Pull Split.
2. The Split initially assigns 100% to the Looti backend/controller address.
3. Creator wallet transfers the campaign reward token budget to the Split.
4. Looti writes a Firestore campaign with `split.splitAddress`,
   `split.fundingTxHash`, `split.splitType: "pull"`, and `split.controller`.
5. When the campaign expires, Looti calculates winners from `/api/algo-quotes`.
6. Looti backend uses `ATLAS_ADDRESS_PRIVATEKEY` to update Split recipients.
7. Looti backend distributes funds.

Atlas should use this same rail, but without the browser wallet flow. The target
architecture is:

1. Atlas casts the prompt.
2. Atlas calls `POST /api/atlas/campaigns` with the prompt cast, budget,
   treasury wallet address, reward mode, expiration, and idempotency key.
3. Looti returns or creates the Looti-compatible Pull Split parameters.
4. Atlas funds the Split-backed campaign contract from its treasury wallet.
5. Looti creates the campaign record with Split metadata.
6. Looti's existing cron owns campaign expiration, winner calculation, recipient
   updates, and distribution.
7. Atlas fetches the frozen reward set and performs memory/point allocation.

V0 development may still support `manual` or `simulated` funding modes, but the
production path should be `atlas_treasury_splits_v2`.

### Splits Funding Adapter

Atlas needs a funding adapter equivalent to Looti's frontend flow, but runnable
from the Atlas VPS or agent harness. Looti still owns the campaign endpoint and
records the funded Split metadata:

```ts
type FundLootiSplitInput = {
  idempotencyKey: string;
  treasuryPrivateKeyRef: string; // resolved by Atlas VPS/agent secrets
  tokenAddress: string;
  tokenDecimals: number;
  amount: number;
  controllerAddress: string;
};

type FundLootiSplitResult = {
  mode: "atlas_treasury_splits_v2";
  splitAddress: string;
  splitCreationTxHash: string;
  fundingTxHash: string;
  splitType: "pull";
  controller: string;
};
```

Implementation notes from Looti:

- `controllerAddress` should match Looti's backend/controller address unless
  Looti exposes a different Atlas-specific controller.
- Pull Split creation starts with the controller as the temporary 100% recipient.
- `distributorFeePercent` is currently `0`.
- ERC20 funding uses `transfer(splitAddress, amountInBaseUnits)`.
- Native ETH funding sends value directly to the Split address.
- Looti backend distribution expects `campaign.split.splitAddress` and
  `campaign.budget.tokenAddress`.

### CLI vs Edge Runtime

The Splits CLI package is `@splits/splits-cli`:

```bash
npm install -g @splits/splits-cli
```

It may be useful for programmatic treasury operations, but Atlas and Looti should
not assume it can run inside a Supabase Edge Function. Edge runtimes are designed
for request handling, not shelling out to local CLIs with wallet material.

Preferred V0 shape:

1. Atlas calls Looti's authenticated campaign endpoint to create/prepare the
   campaign.
2. Atlas runs the funding adapter in its VPS/agent harness so the Atlas treasury
   key stays with Atlas.
3. The adapter uses the Splits SDK directly, or a thin wrapper around
   `@splits/splits-cli` if the CLI is materially simpler.
4. Atlas sends the funded Split metadata back to Looti, or Looti creates the
   campaign record only after the endpoint observes the funding transaction.

If the operation must live outside the VPS, use a normal backend job/function
runtime that can safely run Node processes, access private keys through secrets,
and emit durable logs. Avoid putting treasury signing inside a public request
handler without idempotency, spend limits, and audit records.

Open implementation decision:

- If the Atlas treasury key lives with Atlas, Looti needs an explicit delegated
  spend/signing mechanism instead of a raw private key.
- If the Atlas treasury key lives with Looti, the endpoint must enforce per-run
  and per-week spend ceilings and write an audit event before and after every
  onchain action.

## Atlas Responsibilities

- Generate the simple prompt and inquiry thread.
- Publish the prompt cast.
- Call Looti to create a campaign attached to the prompt cast.
- Wait until campaign close.
- Fetch the reward set.
- Allocate bounded Atlas points with written rationales.
- Write campaign artifacts and memory patches.
- Publish results and memory updates.

## Looti Responsibilities

- Create and track the campaign.
- Handle budget/funding mechanics.
- Fetch quote responses.
- Rank responses.
- Freeze the reward-set snapshot.
- Accept Atlas allocation records.
- Feed Atlas allocations into the relevant reputation/points system once that
  mechanism exists.
