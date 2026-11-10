import type { DeadlinePolicy } from "../../shared/utils/deadline.js";
import { env } from "./env.js";

// How the deadline of a small work is counted, from the settings: APP_TIMEZONE and SMALL_WORKS_ALERT_HOURS_BEFORE. The small
// works, the dashboard and the alert job all take it from here (and tests hand them their own).
export const envDeadlinePolicy = (): DeadlinePolicy => ({
  timeZone: env.APP_TIMEZONE,
  hoursBefore: env.SMALL_WORKS_ALERT_HOURS_BEFORE,
});
