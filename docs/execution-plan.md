# Atlas Execution Plan

This is the active implementation track for taking Atlas from scaffold to first
public campaign.

## Current State

- Atlas repo is scaffolded.
- Atlas memory lives in `world/`.
- Looti is the canonical public-input boundary.
- Looti Atlas API is deployed at `https://looti.club`.
- Looti `POST /api/atlas/campaigns/prepare` has passed a production smoke test.
- Atlas has a dry-run campaign worker that can render campaign prompts, build
  Looti prepare payloads, and optionally call Looti prepare.

## Immediate Goal

Run the first end-to-end Atlas campaign without losing control of funds or
memory quality.

The first live campaign should be small, observable, and reversible in process:

1. Atlas publishes a simple Farcaster prompt and thread.
2. Atlas calls Looti prepare.
3. Atlas receives Split funding instructions.
4. Atlas funds the Split from treasury.
5. Atlas calls Looti activate.
6. Looti ranks/distributes after campaign expiry.
7. Atlas fetches the top reward set.
8. Atlas writes an attributed memory update.

## Milestones

### M1: Prepare Dry Run

Owner: Atlas repo.

Status: ready.

Tasks:

- Fill `.env` with real cast, creator, treasury, and token fields.
- Set `ATLAS_DRY_RUN_CALL_LOOTI=true`.
- Run `pnpm campaign:dry-run`.
- Confirm the artifact contains `lootiPrepareResult.status: "prepared"`.

Success criteria:

- No funding occurs.
- Looti returns valid funding instructions.
- Artifact is written under `world/campaigns/`.

### M2: Treasury Funding Adapter

Owner: Atlas repo.

Status: implemented, pending first live transaction.

Tasks:

- Add a funding adapter interface. Done.
- Implement a dry-run adapter that only echoes funding instructions. Done via
  `campaign:dry-run`.
- Implement a live adapter using one of two modes:
  - V0 hot wallet mode: use `@0xsplits/splits-sdk` / viem to create the Looti
    payout Split and fund it from a dedicated low-balance EOA. Done in
    `packages/sdk/src/splits-funding.ts`.
  - Production treasury mode: use `@splits/splits-cli` or MCP to move funds from
    a Splits Personal/Treasury account under scoped agent authority.
- Require an explicit live-mode flag before any transaction. Done:
  `ATLAS_LIVE_FUNDING_ENABLED=true`.
- Record funding tx metadata in an artifact before activation. Done for
  `world/campaigns/*.launch.json`.

Success criteria:

- Funding code cannot run accidentally from dry-run mode.
- Funding inputs and outputs are recorded.
- Live adapter returns `splitAddress`, `splitCreationTxHash`, `fundingTxHash`,
  `splitType`, and `controller`.

### M3: Activate Campaign

Owner: Atlas repo calling Looti.

Status: implemented, pending first live transaction.

Tasks:

- Add activation worker. Done: `pnpm campaign:launch`.
- Submit the funded Split metadata to Looti. Done in
  `packages/agent/src/campaign-launcher.ts`.
- Confirm Looti returns `status: "active"`.
- Record Looti campaign ID in `world/campaigns/`.

Success criteria:

- Campaign is visible/processable in Looti.
- Looti campaign document has `source.system: "atlas"`.
- Existing Looti cron/distribution path can process it.

### M4: Reward Set Ingestion

Owner: Atlas repo.

Status: implemented for beta mode, blocked by campaign completion for live proof.

Tasks:

- Poll or fetch `GET /api/atlas/campaigns/:campaignId/reward-set?limit=3|10`.
  Done via `pnpm campaign:ingest-reward-set`.
- Write reward-set artifact. Done:
  `world/campaigns/{campaignId}/reward-set.json`.
- Draft memory patch with citations to winning quote hashes. Done as beta
  candidate:
  `world/campaigns/{campaignId}/memory-candidate.md`.
- Record Atlas point allocations via Looti API. Done when
  `ATLAS_RECORD_ALLOCATIONS=true`.

Success criteria:

- Atlas memory only changes from Looti-ranked reward set entries.
- Each memory change has campaign ID, quote hash, rank, and rationale.

## Beta World Mode

Atlas is currently in beta world mode.

Rules:

- Public inputs are real: Looti campaigns and reward sets are the canonical
  evidence boundary.
- Public outputs are real: Atlas may publish campaign prompts and summaries.
- Durable memory mutation is staged: reward-set ingestion writes candidate
  artifacts under `world/campaigns/{campaignId}/`.
- `world/world-state.md`, `world/entities.md`, and `world/timeline.md` are not
  edited automatically by ingestion.
- `ATLAS_RECORD_ALLOCATIONS=true` is allowed because it records Atlas's beta
  scoring/rationale beside Looti payouts without changing Looti payouts.

Promotion to real mode requires:

- At least one completed campaign with non-empty reward-set artifacts.
- A reviewed `memory-candidate.md` whose quote citations are sufficient.
- An explicit `world:apply-candidate` command with allowed update types.

## Structured World Model Track

The long-term world model is not markdown-first. Markdown artifacts are the
review layer. The core data layer should follow
`docs/farcaster-world-model-v1.md`:

- Atlas questions become structured `Question` records.
- Farcaster responses become structured `Answer` and `Claim` records.
- Looti rankings and later real-world checks become mutable `Outcome` records.
- Contributor reputation updates only from behavioral and ground-truth outcome
  labels, not raw engagement.
- Atlas's first optimization target is question selection: which questions were
  worth asking, which produced useful answers, and which changed Atlas's memory
  or behavior.
- Actionable campaigns can trigger an intervention lifecycle. See
  `docs/campaign-lifecycle-v1.md`.

Next build after reward-set ingestion:

1. Add a local/Postgres-backed interaction store schema.
2. Log activated Atlas campaigns as `Question` records.
3. Backfill Looti reward-set entries as `Answer` records.
4. Add delayed outcome tasks for 7/30/90 day review.
5. Add intervention records and jobs for campaigns whose expected action is
   `build_skill`, `build_tool`, or `run_experiment`.

Question policy:

- Atlas should prefer questions with a declared success test.
- Prediction-market-style questions are allowed when they directly inform an
  Atlas action.
- Most Atlas questions should be decision, diagnostic, procedural, evaluation,
  or question-generation questions.
- A question can be valuable without being perfectly provable, but it should be
  resolvable enough to update Atlas's behavior.

## First Campaign Candidate

Reward mode: `top_10`

Problem:

```text
how small Farcaster groups can turn useful discussion into shared working memory.
```

Question:

```text
What is one concrete practice that helps a small online group solve problems together?
```

Evidence request:

```text
examples, failure cases, tools, rituals, metrics
```

First cast:

```text
I need to understand how small Farcaster groups can turn useful discussion into shared working memory.

What is one concrete practice that helps a small online group solve problems together?

Quote this with examples, failure cases, tools, rituals, metrics. @looti will rank responses, and I will update my memory from the top 10.
```

## Required Operator Inputs

These are the only fields Atlas cannot infer safely right now:

- Atlas Farcaster account / signer path
- Prompt cast hash after publishing
- Creator FID for the Atlas account
- Creator wallet address
- Treasury wallet address
- Campaign token address and token decimals
- Initial budget
- Treasury mode: V0 hot wallet or Splits Personal/Treasury account

## Safety Rules

- Never fund from placeholder addresses.
- Never activate a campaign without a recorded funding tx hash.
- Never ingest non-Looti-ranked replies as canonical memory.
- Never commit `.env` or private keys.
- Live funding requires an explicit live-mode flag.
- Prefer Splits Personal/Treasury scoped signer authority over raw private keys
  once Atlas moves beyond tiny test budgets.
