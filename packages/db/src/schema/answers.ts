import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";
import { questions } from "./questions.js";

export const answers = pgTable("answers", {
  id: text("id").primaryKey().$defaultFn(createId),
  questionId: text("question_id").notNull().references(() => questions.id),
  farcasterCastHash: text("farcaster_cast_hash"),
  responderFid: integer("responder_fid"),
  text: text("text").notNull(),
  rationaleExtracted: text("rationale_extracted"),
  confidenceSignaled: text("confidence_signaled"),
  citesSources: boolean("cites_sources").default(false),
  lootiRank: integer("looti_rank"),
  lootiScore: text("looti_score"),
  parentAnswerId: text("parent_answer_id"),
  claims: jsonb("claims").$type<string[]>().default([]),
  respondedAt: timestamp("responded_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Answer = typeof answers.$inferSelect;
export type NewAnswer = typeof answers.$inferInsert;
