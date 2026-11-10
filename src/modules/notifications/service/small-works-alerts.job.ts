import { startIntervalJob, type IntervalJob } from "../../../core/jobs/intervalJob.js";
import { SmallWorksAlertsService } from "./small-works-alerts.service.js";

const HOUR_MS = 60 * 60 * 1000;

// Starts the hourly check of the small works (and one at once, to catch up on what happened while the server was down). Called
// by the server when SMALL_WORKS_ALERT_JOB_ENABLED is true; `npm run jobs:small-works` runs one check by hand instead.
export function startSmallWorksAlertJob(service = new SmallWorksAlertsService()): IntervalJob {
  return startIntervalJob({
    name: "small-works-alerts",
    intervalMs: HOUR_MS,
    run: async () => {
      await service.run();
    },
  });
}
