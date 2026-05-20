import {
  pgTable,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";

export const contextSnapshots = pgTable("context_snapshots", {
  id: text("id").primaryKey().$defaultFn(createId),
  takenAt: timestamp("taken_at", { withTimezone: true }).notNull().defaultNow(),
  relatedRecentCasts: jsonb("related_recent_casts").$type<string[]>().default([]),
  activeContributors: jsonb("active_contributors").$type<number[]>().default([]),
  priorInteractions: jsonb("prior_interactions").$type<string[]>().default([]),
  atlasInternalState: text("atlas_internal_state"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ContextSnapshot = typeof contextSnapshots.$inferSelect;
export type NewContextSnapshot = typeof contextSnapshots.$inferInsert;
