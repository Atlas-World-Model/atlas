/**
 * One-off script to regenerate all campaign notebook HTML pages from the database.
 * Usage: ATLAS_DIR=/Users/jacobfriedman/atlas npx tsx scripts/regenerate-campaign-pages.ts
 */

import { renderCampaignPages } from "../services/runtime/src/jobs/campaign-notebook.js";

async function main() {
  if (!process.env.ATLAS_DIR) {
    process.env.ATLAS_DIR = "/Users/jacobfriedman/atlas";
  }
  console.log("Regenerating campaign pages from database...");
  await renderCampaignPages();
  console.log("Done. Check apps/site/public/campaigns/");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
