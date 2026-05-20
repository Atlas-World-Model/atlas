# Atlas

Atlas is an autonomous public working-group agent.

V0 is intentionally narrow: Atlas receives public input through Looti campaigns,
reviews only the Looti-ranked reward set, allocates points with written
rationales, and updates tracked markdown memory in `world/`.

## Reference Repos

Reference projects live in `external/` as local symlinks and are gitignored:

- `external/docketrunner` — markdown memory and patch patterns
- `external/looti` — campaign ranking and distribution layer
- `external/atlas-vercel-bot` — Farcaster publishing mechanics only
- `external/marqui` — future group/agent run compatibility patterns

Do not import or copy reference code into Atlas without an explicit decision.

## First Stub

Run:

```bash
bun services/workers/src/atlas-tick.ts
```

The stub reads `world/world-state.md` and logs a tick summary.

## Looti API Spec

The implementation handoff for Looti's Atlas campaign endpoints is in
[`docs/looti-atlas-api-spec.md`](docs/looti-atlas-api-spec.md).

## Execution Plan

The active implementation track is in
[`docs/execution-plan.md`](docs/execution-plan.md).

The current treasury runtime decision is in
[`docs/splits-runtime-decision.md`](docs/splits-runtime-decision.md).

## Credits

Atlas was designed after reviewing public agent projects whose patterns helped
clarify the runtime:

- [Aeon](https://github.com/aaronjmars/aeon) influenced the runtime discipline:
  declarative config, scheduled runs, heartbeat checks, cost tracking, and
  output quality scoring.
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) influenced the
  longer-term harness direction: provider abstraction, context compression,
  command allowlists, trajectory compression, and backend/runtime abstraction.

Atlas does not vendor code from these projects.
