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
