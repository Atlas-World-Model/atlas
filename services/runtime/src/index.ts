/**
 * Atlas VPS Runtime — webhook server + Claude Code brain.
 *
 * This is the "thinking" layer. All mechanical scheduled jobs
 * (lifecycle checks, reputation decay, heartbeat, publishing)
 * run on Cloudflare Workers. The VPS handles:
 *
 *   1. Farcaster webhook — receives @atlas mentions, routes to Claude Code
 *   2. Brain API — endpoint for Cloudflare Worker to request reasoning
 *   3. On-demand commands — blog writing, campaign proposals via Farcaster
 *
 * Claude Code is only invoked when reasoning is needed:
 *   - Replying to Farcaster mentions
 *   - Deciding what question to ask next
 *   - Synthesizing campaign results
 *   - Writing blog articles
 *   - Evaluating interventions
 *
 * Usage: bun services/runtime/src/index.ts
 *
 * Env:
 *   DATABASE_URL                    — required
 *   ATLAS_WEBHOOK_PORT              — HTTP port (default 3141)
 *   NEYNAR_API_KEY                  — for Farcaster replies
 *   NEYNAR_WEBHOOK_SECRET           — webhook verification
 *   SIGNER_UUID                     — for Farcaster posting
 *   ATLAS_FARCASTER_REPLY_ENABLED   — "true" to reply to mentions
 *   ATLAS_BLOG_PUBLISH_ENABLED      — "true" to allow blog writing
 *   ATLAS_CAMPAIGN_CREATE_ENABLED   — "true" to allow campaign creation
 */

async function main() {
  console.log("[atlas-runtime] Starting Atlas VPS Runtime");
  console.log(`[atlas-runtime] PID: ${process.pid}`);
  console.log(`[atlas-runtime] Time: ${new Date().toISOString()}`);
  console.log("[atlas-runtime] Mode: webhook server + Claude Code brain");

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  // Start HTTP server (webhook listener + brain API)
  await import("./server/index.js");

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[atlas-runtime] Shutting down...");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[atlas-runtime] Ready. Mechanical jobs run on Cloudflare Workers.");
}

main().catch((err) => {
  console.error("[atlas-runtime] Fatal:", err);
  process.exit(1);
});
