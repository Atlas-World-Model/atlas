/**
 * Shared Claude Code invocation helper.
 * Writes prompt to a temp file to handle long/multiline prompts reliably.
 */

import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { randomBytes } from "crypto";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";

export function invokeClaudeCode(
  prompt: string,
  opts?: { timeout?: number },
): Promise<string> {
  const timeout = opts?.timeout ?? 120_000;
  const tmpFile = `/tmp/atlas-prompt-${randomBytes(6).toString("hex")}.txt`;

  return new Promise(async (resolve) => {
    // Write prompt to temp file
    await writeFile(tmpFile, prompt, "utf8");

    const proc = spawn(
      "bash",
      ["-c", `cat "${tmpFile}" | claude --print`],
      {
        cwd: ATLAS_DIR,
        env: {
          ...process.env,
          PATH: `/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      cleanup();
      resolve("(timed out)");
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0 || !stdout.trim()) {
        if (stderr) console.error(`[claude] stderr: ${stderr.slice(0, 300)}`);
        resolve("(error)");
        return;
      }
      resolve(stdout.trim());
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      cleanup();
      console.error(`[claude] Spawn error: ${err.message}`);
      resolve("(error)");
    });

    function cleanup() {
      unlink(tmpFile).catch(() => {});
    }
  });
}
