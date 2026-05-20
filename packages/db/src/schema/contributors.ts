import {
  pgTable,
  text,
  timestamp,
  integer,
  jsonb,
  real,
} from "drizzle-orm/pg-core";

export const contributors = pgTable("contributors", {
  fid: integer("fid").primaryKey(),
  displayName: text("display_name"),
  domainsActiveIn: jsonb("domains_active_in").$type<string[]>().default([]),
  totalAnswers: integer("total_answers").notNull().default(0),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contributorReputation = pgTable("contributor_reputation", {
  id: text("id").primaryKey(),
  fid: integer("fid").notNull().references(() => contributors.fid),
  domain: text("domain").notNull().default("global"),
  score: real("score").notNull().default(0),
  sampleSize: integer("sample_size").notNull().default(0),
  confidence: real("confidence").notNull().default(0),
  decayHalfLifeDays: integer("decay_half_life_days").notNull().default(180),
  lastUpdatedAt: timestamp("last_updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Contributor = typeof contributors.$inferSelect;
export type NewContributor = typeof contributors.$inferInsert;
export type ContributorReputation = typeof contributorReputation.$inferSelect;
