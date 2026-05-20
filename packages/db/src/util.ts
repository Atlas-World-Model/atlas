import { randomBytes } from "crypto";

export function createId(): string {
  return randomBytes(12).toString("hex");
}
