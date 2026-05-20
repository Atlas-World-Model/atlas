/**
 * Shared Claude Code invocation helper.
 * Sends prompts over stdin so prompt text is not written to disk.
 */

import { spawn } from "child_process";

const ATLAS_DIR = process.env.ATLAS_DIR || "/opt/atlas";

export function invokeClaudeCode(
  prompt: string,
  opts?: { timeout?: number },
): Promise<string> {
  const timeout = opts?.timeout ?? 120_000;

  return new Promise((resolve) => {
    const proc = spawn("claude", ["--print"], {
      cwd: ATLAS_DIR,
      env: {
        ...process.env,
        PATH: `/root/.bun/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      resolve("(timed out)");
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || !stdout.trim()) {
        if (stderr) console.error(`[claude] stderr: ${stderr.slice(0, 300)}`);
        resolve("(error)");
        return;
      }
      resolve(stdout.trim());
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.error(`[claude] Spawn error: ${err.message}`);
      resolve("(error)");
    });

    proc.stdin.end(prompt);
  });
}
