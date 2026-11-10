import { z } from "zod";
import { RECENT_DEFAULT_LIMIT, RECENT_MAX_LIMIT } from "../dto/dashboard.dto.js";

// Out of range is refused, not clamped (the same rule as every list).
export const recentActivityQuerySchema = z.object({
  limit: z.coerce
    .number({ error: "validation.recentLimitInvalid" })
    .int({ error: "validation.recentLimitInvalid" })
    .min(1, { error: "validation.recentLimitInvalid" })
    .max(RECENT_MAX_LIMIT, { error: "validation.recentLimitInvalid" })
    .default(RECENT_DEFAULT_LIMIT),
});

export type RecentActivityQuery = z.output<typeof recentActivityQuerySchema>;
