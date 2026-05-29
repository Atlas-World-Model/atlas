/**
 * One-off script to list published campaign pages from the database.
 * Usage: node scripts/regenerate-campaign-pages.mjs
 */

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);

const pages = await sql`
  SELECT
    p.slug, p.title, p.status, p.body_markdown, p.snapshot_json,
    p.campaign_id, p.campaign_run_id, p.updated_at,
    r.status as run_status, r.created_at as run_created_at
  FROM campaign_public_pages p
  LEFT JOIN campaign_runs r ON p.campaign_run_id = r.id
  WHERE p.status = 'published' AND r.status != 'retired'
  ORDER BY r.created_at ASC
`;

console.log(`Found ${pages.length} published campaign pages:\n`);
for (const page of pages) {
  console.log(`  slug: ${page.slug}`);
  console.log(`  title: ${page.title}`);
  console.log(`  campaign_id: ${page.campaign_id}`);
  console.log(`  updated: ${page.updated_at}`);
  console.log(`  has markdown: ${!!page.body_markdown}`);
  console.log(`  has snapshot: ${!!page.snapshot_json}`);
  const snap = page.snapshot_json || {};
  const contributors = Array.isArray(snap.contributors) ? snap.contributors : [];
  console.log(`  contributors: ${contributors.length}`);
  console.log();
}

await sql.end();
