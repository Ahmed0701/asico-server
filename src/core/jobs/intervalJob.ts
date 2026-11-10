import { logger } from "../config/logger.js";

// A job that runs on a fixed interval inside this process: once at the start (to catch up on what happened while the server
// was down) and then every `intervalMs`. It never throws: a run that fails is logged and the next one still happens. Two
// runs of the same job never overlap in this process. Several server instances each run their own copy, which is why a job
// must take its own lock in the database (see SmallWorksAlertsService); the timer is unref'd, so it never keeps the process alive.
export type IntervalJob = { stop: () => void };

export function startIntervalJob(options: {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  runAtStart?: boolean;
}): IntervalJob {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      logger.warn({ job: options.name }, "the previous run is still going: this one is skipped");
      return;
    }
    running = true;
    try {
      await options.run();
    } catch (err) {
      logger.error({ err, job: options.name }, "job run failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();
  if (options.runAtStart ?? true) {
    setImmediate(() => void tick());
  }
  return { stop: () => clearInterval(timer) };
}
