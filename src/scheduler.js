// scheduler.js — autonomous follow-up.
//
// The Mind is always-on on the platform, but Hearthkeeper's scheduler
// gives it work to do without a human in the loop: it auto-reviews the
// queue, produces the daily community-health digest, and runs the
// repeat-offender escalation review. All schedules are env-tunable.

import cron from "node-cron";
import config from "./config.js";

export function startScheduler({ onAutoReview, onDigest, onEscalation, log = console.log }) {
  const jobs = [];
  let stopped = false;

  const wrap = (name, fn) => async () => {
    if (stopped) return;
    try {
      log(`[scheduler] ${name} — starting`);
      await fn();
      log(`[scheduler] ${name} — done`);
    } catch (err) {
      log(`[scheduler] ${name} — FAILED: ${err.message}`);
    }
  };

  jobs.push({
    name: `auto-review (${config.autoReviewCron})`,
    task: cron.schedule(config.autoReviewCron, wrap("auto-review", async () => {
      const pending = onAutoReview.pendingCount();
      if (pending < config.autoReviewMinPending) {
        log(`[scheduler] auto-review — only ${pending} pending (min ${config.autoReviewMinPending}), skipping`);
        return;
      }
      await onAutoReview.run();
    })),
  });

  jobs.push({
    name: `daily digest (${config.digestCron})`,
    task: cron.schedule(config.digestCron, wrap("daily digest", () => onDigest.run())),
  });

  jobs.push({
    name: `escalation review (${config.escalationCron})`,
    task: cron.schedule(config.escalationCron, wrap("escalation review", () => onEscalation.run())),
  });

  log(`[scheduler] started ${jobs.length} jobs`);
  return {
    jobs,
    stop() {
      stopped = true;
      for (const j of jobs) j.task.stop();
    },
  };
}
