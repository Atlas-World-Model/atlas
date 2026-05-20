<p align="center">
  <img src="apps/site/public/img/atlas-holding-world-hand.png" alt="Atlas" width="280">
</p>

<h1 align="center">Atlas</h1>

<p align="center">
  <strong>An autonomous agent that builds a world model in public.</strong>
</p>

<p align="center">
  <a href="https://joinatlas.xyz">Website</a> ·
  <a href="https://farcaster.xyz/atlas">Farcaster</a> ·
  <a href="https://farcaster.xyz/miniapps/b9xYkctvKDSj/looti">Looti</a>
</p>

---

Atlas runs **campaigns** — structured questions posted to Farcaster — and updates its memory only from the top-ranked responses. The ranking layer is [Looti](https://farcaster.xyz/miniapps/b9xYkctvKDSj/looti). Atlas publishes a question, Looti ranks the replies, and Atlas reviews the winning set. If the evidence is strong enough, Atlas writes it into durable memory. If it isn't, nothing changes.

Every piece of Atlas's memory traces back to a campaign, a contributor, a rank, and a rationale.

## How It Works

```mermaid
graph LR
    A["🔭 Atlas Asks"] --> B["📡 Farcaster Collects"]
    B --> C["⚖️ Looti Ranks"]
    C --> D["🧠 Atlas Learns"]
    D -->|"updates world model"| A

    style A fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0c4a6e
    style B fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#78350f
    style C fill:#fce7f3,stroke:#db2777,stroke-width:2px,color:#831843
    style D fill:#d1fae5,stroke:#059669,stroke-width:2px,color:#064e3b

    linkStyle default stroke:#94a3b8,stroke-width:2px
```

**Question → Answer → Outcome.** Atlas learns from all three.

## Campaign Lifecycle

Each campaign runs a 7-day durable lifecycle as a Cloudflare Workflow:

```mermaid
graph LR
    ASK["Day 0\n─────\nAsk"] --> ENGAGE["Day 0–1\n─────\nEngage &\nCollect"]
    ENGAGE --> SYNTH["Day 1\n─────\nSynthesize"]
    SYNTH -->|"build"| BUILD["Day 2\n─────\nBuild &\nTest"]
    SYNTH -->|"no build"| EVAL
    BUILD --> EVAL["Day 3\n─────\nEvaluate"]
    EVAL --> CLOSE["Day 7\n─────\nClose"]

    style ASK fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0c4a6e
    style ENGAGE fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#78350f
    style SYNTH fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#4c1d95
    style BUILD fill:#fce7f3,stroke:#db2777,stroke-width:2px,color:#831843
    style EVAL fill:#ffedd5,stroke:#ea580c,stroke-width:2px,color:#7c2d12
    style CLOSE fill:#d1fae5,stroke:#059669,stroke-width:2px,color:#064e3b

    linkStyle default stroke:#94a3b8,stroke-width:2px
```

During collection, Atlas doesn't sit idle. It actively engages — replying to ranked contributors, quoting its own cast with new angles, and adding commentary. Atlas works for its attention.

## Architecture

```mermaid
graph TB
    FC["📡 Farcaster / Looti"] -->|"webhook"| WH

    subgraph VPS["🧠 VPS — api.joinatlas.xyz"]
        WH["Webhook Server"] --> BRAIN["Atlas Brain"]
        BRAIN --> CLAUDE["Claude Code"]
        BRAIN --> KG["KG Pipeline"]
    end

    subgraph CF["⚡ Cloudflare"]
        WORKER["Worker Crons"]
        WF["Campaign Workflow"]
    end

    WF -->|"reasoning needed"| BRAIN
    WORKER --> DB
    WF --> DB
    VPS --> DB

    DB[("💾 Supabase")]

    style VPS fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0c4a6e
    style CF fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#78350f
    style DB fill:#d1fae5,stroke:#059669,stroke-width:2px,color:#064e3b
    style FC fill:#fce7f3,stroke:#db2777,stroke-width:2px,color:#831843
    style WH fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
    style BRAIN fill:#ede9fe,stroke:#7c3aed,stroke-width:2px,color:#4c1d95
    style CLAUDE fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
    style KG fill:#ede9fe,stroke:#7c3aed,color:#4c1d95
    style WORKER fill:#fef3c7,stroke:#d97706,color:#78350f
    style WF fill:#fef3c7,stroke:#d97706,color:#78350f

    linkStyle default stroke:#94a3b8,stroke-width:2px
```

**Design principle:** cheap mechanical work runs on Cloudflare. Expensive reasoning (Claude Code) runs on the VPS, only when judgment is needed.

## Reputation

Contributors earn reputation from **outcomes**, not engagement.

```mermaid
graph LR
    E["Engagement\nlikes, replies"] -.->|"logged only"| L["❌ No reputation\nimpact"]
    B["Behavioral\nAtlas used it"] -->|"weight 1x"| R["✅ Reputation\nper-domain\ntime-decayed\n180-day half-life"]
    G["Ground Truth\nit held up"] -->|"weight 2x"| R

    style E fill:#f1f5f9,stroke:#94a3b8,stroke-width:2px,color:#475569
    style L fill:#fef2f2,stroke:#f87171,stroke-width:2px,color:#991b1b
    style B fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#78350f
    style G fill:#e0f2fe,stroke:#0284c7,stroke-width:2px,color:#0c4a6e
    style R fill:#d1fae5,stroke:#059669,stroke-width:2px,color:#064e3b

    linkStyle default stroke:#94a3b8,stroke-width:2px
```

A popular answer can be wrong. An unpopular answer can be the one that changes everything. Atlas only updates reputation from behavioral and ground-truth tiers.

## Question Selection

Atlas is learning which questions are worth asking. A good question has:

- A **problem** — something Atlas doesn't understand well enough
- A **current belief** — what Atlas thinks now, so answers can challenge it
- A **success test** — how to tell if the answers were useful
- A **reason human input matters** — why Atlas can't figure this out alone
- A **path to behavior change** — how a good answer would change what Atlas does next

## Monorepo Structure

```
atlas/
├── apps/
│   ├── atlas-console/          # Planned: internal dashboard
│   └── site/                   # joinatlas.xyz (Cloudflare Pages)
├── packages/
│   ├── agent/                  # Campaign orchestration + lifecycle + reputation
│   ├── db/                     # Drizzle schema (12 tables) + client
│   ├── memory/                 # World state I/O
│   └── sdk/                    # Looti API client + Splits funding
├── services/
│   ├── cf-worker/              # Cloudflare Worker + Workflow
│   ├── runtime/                # VPS webhook server + Claude Code brain
│   └── workers/                # CLI workers (launch, synthesize, etc.)
├── world/                      # Atlas's canonical memory (markdown)
│   ├── world-state.md
│   ├── entities.md
│   ├── operator.md
│   ├── timeline.md
│   └── campaigns/
└── docs/                       # Specs and handoffs
```

## Getting Started

```bash
# Install
pnpm install

# Set up environment
cp env.example .env
# Fill in: DATABASE_URL, ATLAS_LOOTI_API_KEY, NEYNAR_API_KEY, etc.

# Push database schema
pnpm db:push

# Run a dry-run campaign
pnpm campaign:dry-run

# Start the runtime (VPS mode)
pnpm runtime

# Typecheck
pnpm typecheck
```

## Commands

| Command | Description |
|---|---|
| `pnpm runtime` | Start webhook server + brain |
| `pnpm campaign:dry-run` | Test campaign without funding |
| `pnpm campaign:launch` | Full launch: prepare + fund + activate |
| `pnpm campaign:synthesize` | Process day 7 synthesis |
| `pnpm campaign:init-lifecycle` | Create DB lifecycle records |
| `pnpm lifecycle:check` | Process due outcome checks |
| `pnpm reputation:update` | Update reputation from outcomes |
| `pnpm tick` | Heartbeat check |
| `pnpm db:push` | Push schema to database |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm typecheck` | TypeScript type check |

## Farcaster Commands

Tag `@atlas` on Farcaster:

| Command | Description | Access |
|---|---|---|
| `@atlas [question]` | Atlas replies using Claude Code | Beta allowlist |
| `@atlas write about [topic]` | Atlas writes + publishes a blog article | Operator only |
| `@atlas research [topic]` | Atlas proposes a new campaign | Operator only |

## Tech Stack

- **Runtime**: Bun (VPS), Cloudflare Workers (crons + workflows)
- **Database**: Supabase (Postgres) with Drizzle ORM
- **AI**: Claude Code (reasoning), Gemini (contributor profiling via KG pipeline)
- **Blockchain**: Base (ATL token, Splits contracts via viem)
- **Social**: Farcaster (Neynar SDK), Looti (campaign ranking)
- **Site**: Cloudflare Pages (static HTML)

## Articles

1. [Atlas Is Building a World Model in Public](https://joinatlas.xyz)
2. [Atlas Is Learning Which Questions Are Worth Asking](https://joinatlas.xyz/questions)
3. [How Atlas Learns From What Happens After the Answer](https://joinatlas.xyz/outcomes)

## License

AGPL-3.0

## Credits

Atlas was designed after reviewing public agent projects:

- [Aeon](https://github.com/aaronjmars/aeon) — runtime discipline, cost tracking, output scoring
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — provider abstraction, context compression

Atlas does not vendor code from these projects.
