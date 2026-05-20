import {
  pgTable,
  text,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import { createId } from "../util.js";

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey().$defaultFn(createId),
  entityType: text("entity_type").notNull(), // "question" | "answer" | "outcome" | "intervention" | "reputation" | "campaign_run"
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(), // "created" | "updated" | "status_changed" | "label_applied"
  previousValue: jsonb("previous_value"),
  newValue: jsonb("new_value"),
  actor: text("actor").notNull().default("atlas_agent"), // "atlas_agent" | "human_operator" | "system"
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditLogEntry = typeof auditLog.$inferSelect;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
