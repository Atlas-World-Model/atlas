# VPS Handoff — 2026-05-20

## Infrastructure

- **Provider**: Hostinger VPS
- **IP**: 187.77.9.131
- **OS**: Ubuntu 24.04.3 LTS
- **SSH**: `ssh -i ~/.ssh/atlas_vps root@187.77.9.131`

## Installed globally

| Tool | Version | Path |
|---|---|---|
| Bun | 1.3.14 | `/root/.bun/bin/bun` |
| Node | v22.22.2 | `/usr/bin/node` |
| Claude Code | 2.1.145 | `claude` (npm global) |
| Python | 3.12.3 | `/usr/bin/python3` |
| uv | 0.11.15 | `/root/.local/bin/uv` |
| Pillow | installed | via system apt |
| nginx | installed | system service |

## Services (systemd)

### atlas-runtime

- **Unit**: `/etc/systemd/system/atlas-runtime.service`
- **Working dir**: `/opt/atlas`
- **Command**: `bun services/runtime/src/index.ts`
- **Port**: 3141 (internal, proxied by nginx)
- **Role**: Webhook server + Claude Code brain. No scheduler — mechanical
  jobs run on Cloudflare Workers.
- **Restart**: `systemctl restart atlas-runtime`
- **Logs**: `journalctl -u atlas-runtime -f`

### atlas-kg

- **Unit**: `/etc/systemd/system/atlas-kg.service`
- **Working dir**: `/opt/kg-pipeline`
- **Command**: `uv run uvicorn main:app --host 127.0.0.1 --port 8200`
- **Port**: 8200 (internal only, no nginx proxy)
- **Role**: Knowledge graph pipeline for contributor profiling. Called by
  atlas-runtime during campaign engagement to understand who contributors are.
- **Mode**: Ephemeral (ALLOW_NO_DATABASE=true), no persistent graph storage.
- **Restart**: `systemctl restart atlas-kg`
- **Logs**: `journalctl -u atlas-kg -f`

## nginx

Config at `/etc/nginx/sites-enabled/atlas`:

```
server {
    listen 80;
    listen 443 ssl;
    server_name api.joinatlas.xyz;
    ssl_certificate /etc/ssl/certs/atlas.crt;       # self-signed, Cloudflare handles real SSL
    ssl_certificate_key /etc/ssl/private/atlas.key;
    location / {
        proxy_pass http://127.0.0.1:3141;
    }
}
```

Cloudflare DNS: `api.joinatlas.xyz` → A record `187.77.9.131` (proxied).
Cloudflare terminates HTTPS, sends HTTPS to origin (self-signed cert accepted).

Other nginx sites: `default` (OpenClaw), `marqui`, `n8n`.

## Ports

| Port | Service | Access |
|---|---|---|
| 80 | nginx | public (Cloudflare proxy) |
| 443 | nginx | public (Cloudflare proxy) |
| 3141 | atlas-runtime (Bun) | internal (nginx proxied) |
| 8200 | atlas-kg (uvicorn) | internal only |

## Environment variables on VPS

File: `/opt/atlas/.env`

Key variables (values redacted):

```
DATABASE_URL=***                         # Supabase session pooler
NEYNAR_API_KEY=***                       # Farcaster API
SIGNER_UUID=***                          # Atlas Farcaster signer
NEYNAR_WEBHOOK_SECRET=***                # Webhook signature verification
ATLAS_FARCASTER_REPLY_ENABLED=true       # Atlas replies to mentions
ATLAS_REPLY_ALLOWED_FIDS=11528           # Only replies to Jacob during beta
ATLAS_BLOG_PUBLISH_ENABLED=true          # Can write/publish blog articles
ATLAS_BRAIN_ENABLED=true                 # Autonomous brain ticks enabled
ATLAS_CAMPAIGN_CREATE_ENABLED=true       # Can propose/create campaigns
ATLAS_LIVE_FUNDING_ENABLED=true          # Can fund splits on-chain
ATLAS_LIVE_ACTIVATION_ENABLED=true       # Can activate Looti campaigns
ATLAS_TREASURY_WALLET_ADDRESS=***        # Hot wallet for campaign funding
ATLAS_TREASURY_PRIVATE_KEY=***           # Hot wallet private key
ATLAS_CREATOR_FID=12193                  # Atlas Farcaster FID
ATLAS_CREATOR_ADDRESS=***               # Atlas creator wallet
ATLAS_CAMPAIGN_TOKEN=ATL                 # Campaign reward token
ATLAS_CAMPAIGN_TOKEN_ADDRESS=***         # ATL token contract (Base)
ATLAS_CF_WORKER_URL=https://atlas-worker.jacob-247.workers.dev
ATLAS_KG_PIPELINE_URL=http://127.0.0.1:8200
ATLAS_LOOTI_API_BASE_URL=https://looti.club
ATLAS_LOOTI_API_KEY=***
CLOUDFLARE_API_TOKEN=***
SUPABASE_SECRET_KEY=***
```

## Cloudflare Worker

- **Name**: `atlas-worker`
- **URL**: https://atlas-worker.jacob-247.workers.dev
- **Crons**:
  - `0 */6 * * *` — heartbeat
  - `0 5 * * *` — reputation decay
  - `*/30 * * * *` — Farcaster campaign publishing
- **Workflow**: `atlas-campaign-lifecycle` — durable per-campaign state machine
- **Secrets set**: SUPABASE_URL, SUPABASE_SECRET_KEY, NEYNAR_WEBHOOK_SECRET, ATLAS_VPS_BRAIN_URL
- **Deploy**: `cd services/cf-worker && CLOUDFLARE_API_TOKEN=*** npx wrangler deploy`

## Cloudflare Pages (joinatlas.xyz)

- **Project**: `joinatlas-xyz`
- **Source**: `apps/site/public/`
- **Custom domain**: `joinatlas.xyz` (active, SSL active)
- **DNS**: Cloudflare zone `86b7c02e45ca9a4ffbca5a4054270e3d`
- **Deploy**: `cd apps/site && CLOUDFLARE_API_TOKEN=*** npx wrangler pages deploy public --project-name joinatlas-xyz --commit-dirty=true`

## Deploy workflow

```bash
# From local machine:
# 1. Sync code to VPS
rsync -avz --delete --exclude node_modules --exclude .env --exclude .git \
  -e "ssh -i ~/.ssh/atlas_vps" ~/atlas/ root@187.77.9.131:/opt/atlas/

# 2. Restart
ssh -i ~/.ssh/atlas_vps root@187.77.9.131 "systemctl restart atlas-runtime"

# 3. Deploy CF worker (if changed)
cd services/cf-worker && CLOUDFLARE_API_TOKEN=*** npx wrangler deploy

# 4. Deploy site (if changed)
cd apps/site && CLOUDFLARE_API_TOKEN=*** npx wrangler pages deploy public --project-name joinatlas-xyz --commit-dirty=true
```

## Architecture summary

```
Farcaster @atlas mention
  → Neynar webhook → api.joinatlas.xyz (nginx)
    → atlas-runtime (Bun, port 3141)
      → Claude Code for reasoning
      → atlas-kg (port 8200) for contributor profiling
      → Neynar API for replies

Cloudflare Worker (crons)
  → Supabase DB for mechanical jobs
  → VPS brain API for reasoning tasks

Cloudflare Workflow (per campaign)
  → Day 0: collect → engage every 4h (calls VPS brain)
  → Day 1: synthesize (calls VPS brain)
  → Day 2: build/test (if applicable)
  → Day 3: evaluate (calls VPS brain)
  → Day 7: final label + close (calls VPS brain)
```
