import type { ResolvedConfig } from "../../config.js";
import { log } from "../../logger.js";
import type { CuratorRunner } from "./runner.js";

/**
 * Spec 04 §5: the curator is NOT a cron — it runs on a serve-process
 * maintenance timer when the machine/user is idle enough:
 *   - >= interval_hours (default 168 = 7d) since the last run
 *   - >= min_idle_hours (default 2h) without any turn activity
 * First run is observation only: state.lastRunAt is set so the next due
 * date lands one interval later.
 */
export interface CuratorSchedulerOptions {
  intervalMs?: number;
  /** returns ms since the last turn activity (serve tracks this) */
  idleSince: () => number;
}

export interface CuratorScheduler {
  stop(): void;
}

export function startCuratorScheduler(
  cfg: ResolvedConfig,
  runner: CuratorRunner,
  opts: CuratorSchedulerOptions,
): CuratorScheduler | undefined {
  if (cfg.curator.enabled === false) return undefined;
  const tick = Math.max(1, opts.intervalMs ?? 15) * 60_000;
  const intervalHours = (cfg.curator.interval_hours ?? 168) * 3_600_000;
  const idleMs = (cfg.curator.min_idle_hours ?? 2) * 3_600_000;

  const timer = setInterval(() => {
    if (runner.readState().paused) return;
    const state = runner.readState();
    // First-run observation: record the start, don't act until one interval passed.
    if (state.lastRunAt === undefined) {
      runner.runPhase1({ dryRun: true, observation: true });
      return;
    }
    if (Date.now() - state.lastRunAt < intervalHours) return;
    if (opts.idleSince() < idleMs) return;

    try {
      const res = runner.runPhase1({});
      if (cfg.curator.consolidate === true) {
        void runner
          .runConsolidation({})
          .then((r) => {
            if (r.staged > 0) {
              log.info(`curator consolidation staged ${r.staged} proposal(s)`);
            }
          })
          .catch(() => {
            /* consolidation must never crash the serve process */
          });
      }
      log.info(
        `curator scheduled run: staled ${res.staled.length}, archived ${res.archived.length}`,
      );
    } catch (err) {
      log.warn(
        `curator scheduled run failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, tick);
  timer.unref?.();

  return {
    stop: (): void => {
      clearInterval(timer);
    },
  };
}
