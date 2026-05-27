import {
  pgTable,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";
import { campaignRuns } from "./campaign-runs.js";

export const campaignPublicPages = pgTable("campaign_public_pages", {
  id: text("id").primaryKey().$defaultFn(createId),
  campaignRunId: text("campaign_run_id").notNull().references(() => campaignRuns.id),
  campaignId: text("campaign_id").notNull(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("published"),
  bodyMarkdown: text("body_markdown").notNull().default(""),
  snapshotJson: jsonb("snapshot_json").$type<Record<string, unknown>>().default({}),
  lastGeneratedAt: timestamp("last_generated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const campaignPublicEvents = pgTable("campaign_public_events", {
  id: text("id").primaryKey().$defaultFn(createId),
  campaignRunId: text("campaign_run_id").notNull().references(() => campaignRuns.id),
  campaignId: text("campaign_id").notNull(),
  eventType: text("event_type").notNull(),
  source: text("source").notNull(),
  bodyMarkdown: text("body_markdown").notNull().default(""),
  snapshotJson: jsonb("snapshot_json").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CampaignPublicPage = typeof campaignPublicPages.$inferSelect;
export type NewCampaignPublicPage = typeof campaignPublicPages.$inferInsert;
export type CampaignPublicEvent = typeof campaignPublicEvents.$inferSelect;
export type NewCampaignPublicEvent = typeof campaignPublicEvents.$inferInsert;
