# VPS Runtime Notes

Atlas can run as a long-lived Bun process on the VPS:

```sh
pnpm runtime
```

## Required env

```sh
DATABASE_URL=
ATLAS_WORLD_DIR=world
ATLAS_LOOTI_API_BASE_URL=https://looti.club
ATLAS_LOOTI_API_KEY=
ATLAS_REWARD_SET_LIMIT=10
ATLAS_RECORD_ALLOCATIONS=false
```

## Optional publishing env

Farcaster publishing is disabled unless explicitly enabled:

```sh
ATLAS_FARCASTER_PUBLISH_ENABLED=false
NEYNAR_API_KEY=
SIGNER_UUID=
```

Set `ATLAS_FARCASTER_PUBLISH_ENABLED=true` only after confirming that any
unpublished `ask` or `collect` campaign rows are intended to be cast.

## Treasury env

The runtime does not need treasury signing env for lifecycle checks. Only set
these when intentionally launching/funding campaigns from the VPS:

```sh
ATLAS_TREASURY_WALLET_ADDRESS=
ATLAS_TREASURY_PRIVATE_KEY=
ATLAS_BASE_RPC_URL=https://mainnet.base.org
ATLAS_LIVE_FUNDING_ENABLED=false
ATLAS_LIVE_ACTIVATION_ENABLED=false
ATLAS_ALLOW_REUSE_DEPLOYED_SPLIT=false
ATLAS_ALLOW_ADDITIONAL_FUNDING=false
```

`ATLAS_ALLOW_ADDITIONAL_FUNDING=true` is intentionally separate from
`ATLAS_ALLOW_REUSE_DEPLOYED_SPLIT=true`; it permits sending more tokens to an
already-deployed deterministic split.

## Process manager

Use a process manager that restarts on crash and preserves logs, such as
`systemd`, `pm2`, or Hostinger's process manager. The process should start from
the repo root so `world/` and campaign artifacts resolve correctly.

Example systemd shape:

```ini
[Unit]
Description=Atlas Runtime
After=network-online.target

[Service]
WorkingDirectory=/path/to/atlas
EnvironmentFile=/path/to/atlas/.env
ExecStart=/path/to/pnpm runtime
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

## Startup checklist

- Run `pnpm typecheck`.
- Run `pnpm tick` with the same env the service will use.
- Start with `ATLAS_FARCASTER_PUBLISH_ENABLED=false`.
- Confirm heartbeat audit rows are writing.
- Confirm `lifecycle:check` finds or skips due checks without errors.
- Enable Farcaster publishing only when the pending DB rows have been reviewed.
