# Infrastructure Handoff — 2026-05-19

## What was built

### Database (Supabase / Postgres)

12 tables pushed to `aws-1-us-west-2.pooler.supabase.com`:

| Table | Purpose |
|---|---|
| `questions` | Campaign questions with problem, belief, success_test, expected_action, question_type, resolvability |
| `answers` | Ranked responses from Looti with fid, cast hash, rank, score |
| `claims` | Individual claims extracted from answers, with checkable/verdict tracking |
| `outcomes` | 3-tier outcome labels (engagement / behavioral / ground_truth), mutable with supersedes chain |
| `contributors` | Farcaster FID-keyed contributor records |
| `contributor_reputation` | Per-domain, time-decayed (180-day half-life), confidence-scored reputation |
| `campaign_runs` | Full lifecycle state machine tracking |
| `interventions` | Scoped experiments with owner, evaluation plan, rollback condition |
| `intervention_events` | Activity log for interventions |
| `outcome_checks` | Scheduled 7/30/90-day checks |
| `context_snapshots` | What Atlas knew when it asked |
| `audit_log` | Append-only record of every state change |

Schema source: `packages/db/src/schema/*.ts`
Migration: `packages/db/drizzle/0000_cooing_reaper.sql`
Drizzle config: `drizzle.config.ts`

### Campaign lifecycle state machine

Source: `packages/agent/src/campaign-lifecycle.ts`

Valid transitions:

```
ask → collect → synthesize → build_test → evaluate → iterate → remember → closed
                           ↘ evaluate ──────────────↗
                           ↘ remember → closed
                           ↘ closed
```

Guardrail: only `build_skill`, `build_tool`, `run_experiment` expected actions can
enter `build_test` stage. Everything else skips to `evaluate` or `remember`.

On campaign init, three outcome checks are auto-scheduled at day 7, 30, and 90.

### Reputation system

Source: `packages/agent/src/reputation.ts`

- Engagement-tier outcomes are logged but never update reputation.
- Behavioral outcomes update reputation with weight 1.
- Ground-truth outcomes update reputation with weight 2.
- Verdicts: correct (+1w), partially_correct (+0.5w), incorrect (-1w), unverifiable (-0.1w).
- Time decay: exponential, 180-day half-life, applied daily.
- Confidence: saturates at 20 samples.
- Scores are per-domain (e.g. `global`, or future domain tags).

### New workers

| Command | File | Purpose |
|---|---|---|
| `pnpm campaign:init-lifecycle` | `services/workers/src/campaign-init-lifecycle.ts` | Create question + campaign run + schedule outcome checks |
| `pnpm campaign:synthesize` | `services/workers/src/campaign-synthesize.ts` | Day 7: ingest reward set, determine next action, transition lifecycle |
| `pnpm lifecycle:check` | `services/workers/src/lifecycle-check.ts` | Process due outcome checks (run on schedule, e.g. every 6 hours) |
| `pnpm reputation:update` | `services/workers/src/reputation-update.ts` | Compute reputation from resolved outcomes + apply time decay |

### DB management scripts

| Command | Purpose |
|---|---|
| `pnpm db:generate` | Generate migration SQL from schema changes |
| `pnpm db:migrate` | Run pending migrations |
| `pnpm db:push` | Push schema directly (dev mode) |
| `pnpm db:studio` | Open Drizzle Studio (visual DB browser) |

### joinatlas.xyz (Cloudflare Pages)

Static site at `apps/site/`, deployed to Cloudflare Pages.

Custom domain `joinatlas.xyz` is active with SSL.

Pages:
- `/` — Atlas Is Building a World Model in Public
- `/questions` — Atlas Is Learning Which Questions Are Worth Asking
- `/outcomes` — How Atlas Learns From What Happens After the Answer
- `/blog` — Article index

OG images generated per article with Atlas character graphics from `atlas-loot`.

### Environment variables added

```
DATABASE_URL        — Supabase pooler connection string (session mode)
CLOUDFLARE_API_TOKEN — Cloudflare Workers/Pages + DNS token
SUPABASE_SECRET_KEY  — Supabase service role key
```

All in `/Users/jacobfriedman/atlas/.env` (gitignored).

## Existing workers (unchanged)

| Command | Purpose |
|---|---|
| `pnpm campaign:dry-run` | Test campaign without funding |
| `pnpm campaign:launch` | Full launch: prepare + fund split + activate |
| `pnpm campaign:activate-funded` | Recover activation for already-funded campaign |
| `pnpm campaign:ingest-reward-set` | Fetch reward set + write markdown artifacts |
| `pnpm tick` | Heartbeat check |

These still work as before. The new lifecycle workers are additive — they write to the
database alongside the existing markdown artifacts.

## What is NOT yet built

1. **DB uniqueness/index migrations** — lifecycle and synthesis now do code-level
   duplicate checks, but Postgres should enforce uniqueness for campaign IDs,
   answer cast hashes, and check types per campaign run.

2. **Outcome labeling UI/worker** — 7/30/90 checks advance lifecycle and synthesize
   evidence, but day 30/90 still need actual outcome labeling workflows.

3. **Farcaster publishing hardening** — runtime publishing exists and is gated by
   `ATLAS_FARCASTER_PUBLISH_ENABLED=true`, but it needs beta review before enabling
   unattended posting.

4. **Intervention creation** — the `interventions` table exists but no worker creates
   intervention records. This is manual/operator-driven in beta.

5. **Question usefulness scoring** — the schema supports it but no heuristic scorer exists.

6. **Contributor routing predictor** — planned for M4, needs enough resolved triples first.

7. **VPS process supervision** — runtime scheduler exists. Configure it under
   systemd/pm2/Hostinger process manager with logs and restart policy.

8. **Claim extraction** — no worker parses answers into individual claims. Manual for beta.
