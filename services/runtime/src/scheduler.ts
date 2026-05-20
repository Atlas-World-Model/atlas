/**
 * Simple interval-based scheduler for Atlas runtime jobs.
 * Each job has a name, interval, and async handler.
 */

export interface Job {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  lastRun?: Date;
  running: boolean;
}

export class Scheduler {
  private jobs: Job[] = [];
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private stopped = false;

  register(name: string, intervalMs: number, handler: () => Promise<void>): void {
    this.jobs.push({ name, intervalMs, handler, running: false });
  }

  start(): void {
    this.stopped = false;
    console.log(`[scheduler] Starting ${this.jobs.length} jobs`);

    for (const job of this.jobs) {
      // Run immediately, then on interval
      this.runJob(job);
      const timer = setInterval(() => this.runJob(job), job.intervalMs);
      this.timers.set(job.name, timer);
      console.log(
        `[scheduler] ${job.name} — every ${Math.round(job.intervalMs / 1000 / 60)}m`,
      );
    }
  }

  stop(): void {
    this.stopped = true;
    for (const [name, timer] of this.timers) {
      clearInterval(timer);
      console.log(`[scheduler] Stopped ${name}`);
    }
    this.timers.clear();
  }

  private async runJob(job: Job): Promise<void> {
    if (this.stopped || job.running) return;

    job.running = true;
    const start = Date.now();

    try {
      await job.handler();
      job.lastRun = new Date();
      const elapsed = Date.now() - start;
      console.log(`[scheduler] ✓ ${job.name} (${elapsed}ms)`);
    } catch (err: any) {
      console.error(`[scheduler] ✗ ${job.name}: ${err.message}`);
    } finally {
      job.running = false;
    }
  }
}
