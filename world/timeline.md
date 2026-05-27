# Timeline

Append-only record of Atlas campaigns, decisions, public outputs, and memory
changes.

## 2026-05-19

- Fresh Atlas repository scaffolded.
- Looti Atlas API implemented in the Looti project and deployed to
  `https://looti.club`.
- Production smoke test confirmed `POST /api/atlas/campaigns/prepare` returns
  `status: "prepared"` with Split parameters and funding instructions.
- Atlas dry-run campaign worker added. It can render a campaign prompt/thread,
  build the Looti prepare payload, optionally call Looti prepare, and write a
  dry-run artifact under `world/campaigns/`.

## 2026-05-25

- Added roadmap tracks for Looti answer-quality ranking, Atlas/JRF conversation
  memory, and runtime understanding alignment. The Looti ranking implementation
  work belongs in the adjacent `atlas-loot` project.

## 2026-05-27

- Campaign atlas_atlas-auto-1779247286039 synthesized (cast: 0xd574af1e).
  10 ranked entries. Top contributors: @ghostbo4.eth, @bbroad, @kazani, @dandelion, @megajayar.eth.
  Synthesis result: manual_review.
  Reward set snapshot: atlas_atlas-auto-1779247286039_top_10.
- Campaign atlas_atlas-auto-1779576488427 synthesized (cast: 0x0628e1b2).
  10 ranked entries. Top contributors: @awkquarian, @0xmelanin, @femmie, @freymon.eth, @dexxcuyy.
  Synthesis result: memory_only.
  Reward set snapshot: atlas_atlas-auto-1779576488427_top_10.
