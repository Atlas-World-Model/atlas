import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorldStateRead {
  path: string;
  content: string;
}

export async function readWorldState(worldDir = "world"): Promise<WorldStateRead> {
  const path = resolve(process.cwd(), worldDir, "world-state.md");
  const content = await readFile(path, "utf8");
  return { path, content };
}

