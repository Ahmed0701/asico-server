import { z } from "zod";
import { MAX_PROGRESS } from "../dto/villa-progress.dto.js";

export const villaPhaseParams = z.strictObject({
  villaId: z.uuid({ error: "validation.idInvalid" }),
  elecPhaseId: z.uuid({ error: "validation.idInvalid" }),
});

// A whole number from 0 to 100. One refine, so every bad value (text, 1.5, 101, a missing field) gives one error.
export const updatePhaseProgressSchema = z.strictObject({
  progress: z
    .number({ error: "validation.progressInvalid" })
    .refine((value) => Number.isInteger(value) && value >= 0 && value <= MAX_PROGRESS, {
      error: "validation.progressInvalid",
    }),
});

export type VillaPhaseParams = z.output<typeof villaPhaseParams>;
export type UpdatePhaseProgressInput = z.output<typeof updatePhaseProgressSchema>;
