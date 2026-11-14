import { log } from "../logger.js";
import type { CronJob } from "../config.js";

/**
 * M5: scheduled prompts (serve-process feature; not an OS crontab).
 * Jobs come from config (cron.jobs). `every_minutes: 0` means "run once
 * when the server boots"; positive values repeat from process start.
 * Cron turns run unattended — unapproved risky tools are denied instantly
 * (the server wraps cron sessions with a deny-all approval adapter).
 */
export interface CronJobRuntimeStatus {
  name: string;
  everyMinutes: number;
  prompt: string;
  lastRunAt?: number;
  lastStatus?: "ok" | "error";
  nextRunAt?: number;
  onceAtBoot: boolean;
  ranOnce: boolean;
  /** false when the job is paused (config `enabled: false` or a live toggle) */
  enabled: boolean;
}

export interface CronSchedulerOptions {
  /** ms between due checks (default 30s; tests can raise it) */
  tickMs?: number;
}

export class CronScheduler {
  private readonly statuses = new Map<string, CronJobRuntimeStatus>();
  private timers: NodeJS.Timeout[] = [];
  /** jobs currently running — a slow run must not overlap its next tick */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly jobs: CronJob[],
    private readonly run: (job: CronJob) => Promise<void>,
  ) {
    for (const job of this.jobs) {
      this.statuses.set(this.key(job), {
        name: job.name ?? job.prompt.slice(0, 24),
        everyMinutes: job.every_minutes,
        prompt: job.prompt,
        onceAtBoot: job.every_minutes <= 0,
        ranOnce: false,
        enabled: job.enabled !== false,
      });
    }
  }

  private key(job: CronJob): string {
    return job.name ?? job.prompt.slice(0, 40);
  }

  /** Find a job by its display name or key. */
  private jobByName(name: string): CronJob | undefined {
    return this.jobs.find((j) => (j.name ?? j.prompt.slice(0, 24)) === name || this.key(j) === name);
  }

  /** Run a job immediately (regardless of its schedule / enabled flag). */
  runNow(name: string): boolean {
    const job = this.jobByName(name);
    if (!job) return false;
    void this.execute(job);
    return true;
  }

  /** Pause/resume a job in memory (the config file is not rewritten). */
  setEnabled(name: string, enabled: boolean): boolean {
    const job = this.jobByName(name);
    if (!job) return false;
    const st = this.statuses.get(this.key(job));
    if (!st) return false;
    st.enabled = enabled;
    // a once-at-boot job that is enabled later should still fire once
    if (enabled && job.every_minutes <= 0 && !st.ranOnce) {
      const t = setTimeout(() => void this.execute(job), 500);
      t.unref?.();
      this.timers.push(t);
    }
    return true;
  }

  start(): void {
    for (const job of this.jobs) {
      if (job.every_minutes <= 0) {
        if (job.enabled === false) continue;
        // once at boot (slight delay so transports/lists settle)
        const t = setTimeout(() => {
          void this.execute(job);
        }, 500);
        t.unref?.();
        this.timers.push(t);
        continue;
      }
      // create a ticker for every repeating job; the tick itself honors the
      // live enabled flag so cron.enable/disable works without a restart
      const periodMs = job.every_minutes * 60_000;
      const tick = setInterval(() => {
        const st = this.statuses.get(this.key(job))!;
        const due = st.lastRunAt === undefined || Date.now() - st.lastRunAt >= periodMs;
        if (st.enabled && due && !this.inFlight.has(this.key(job))) void this.execute(job);
      }, Math.min(periodMs, 30_000));
      tick.unref?.();
      this.timers.push(tick);
    }
    if (this.jobs.length > 0) {
      log.info(`cron: scheduled ${this.jobs.length} job(s)`);
    }
  }

  private async execute(job: CronJob): Promise<void> {
    const k = this.key(job);
    if (this.inFlight.has(k)) return; // never overlap a run with itself
    const st = this.statuses.get(k)!;
    const started = Date.now();
    st.lastRunAt = started;
    this.inFlight.add(k);
    try {
      await this.run(job);
      st.lastStatus = "ok";
    } catch (err) {
      st.lastStatus = "error";
      log.warn(
        `cron ${st.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.inFlight.delete(k);
      st.ranOnce = true;
      st.nextRunAt = st.onceAtBoot ? undefined : (st.lastRunAt ?? 0) + job.every_minutes * 60_000;
      void started;
    }
  }

  status(): { started: boolean; jobs: CronJobRuntimeStatus[] } {
    return {
      started: this.timers.length > 0,
      jobs: [...this.statuses.values()],
    };
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }
}
