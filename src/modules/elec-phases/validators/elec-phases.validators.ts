import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { name } from "../../../shared/validation/fields.js";
import { ELEC_PHASE_STATUSES, MAX_OPTIONS, MAX_PROGRESS_RATIO } from "../dto/elec-phases.dto.js";

const status = z.enum(ELEC_PHASE_STATUSES, { error: "validation.elecPhaseStatusInvalid" });
const progressRatio = z
  .number({ error: "validation.progressRatioInvalid" })
  .int({ error: "validation.progressRatioInvalid" })
  .min(0, { error: "validation.progressRatioInvalid" })
  .max(MAX_PROGRESS_RATIO, { error: "validation.progressRatioInvalid" });

export const listElecPhasesQuerySchema = paginationQuerySchema.extend({
  status: status.optional(),
});

// A new phase goes to the end of the list and is ACTIVE unless it says otherwise. Its progress ratio is 0 unless given.
export const createElecPhaseSchema = z.strictObject({
  name,
  status: status.optional(),
  progressRatio: progressRatio.optional(),
});

export const updateElecPhaseSchema = z
  .strictObject({ name: name.optional(), status: status.optional(), progressRatio: progressRatio.optional() })
  .refine(
    (value) => value.name !== undefined || value.status !== undefined || value.progressRatio !== undefined,
    {
      error: "validation.atLeastOneField",
    },
  );

// Every phase, once, in the order they should have. Whether that really is every phase is checked against the table.
export const reorderElecPhasesSchema = z.strictObject({
  ids: z
    .array(z.uuid({ error: "validation.idInvalid" }), { error: "validation.elecPhaseIdsInvalid" })
    .min(1, { error: "validation.elecPhaseIdsInvalid" })
    .max(MAX_OPTIONS, { error: "validation.elecPhaseIdsInvalid" })
    .refine((ids) => new Set(ids).size === ids.length, { error: "validation.elecPhaseIdsInvalid" }),
});

export type ListElecPhasesQuery = z.output<typeof listElecPhasesQuerySchema>;
export type CreateElecPhaseInput = z.output<typeof createElecPhaseSchema>;
export type UpdateElecPhaseInput = z.output<typeof updateElecPhaseSchema>;
export type ReorderElecPhasesInput = z.output<typeof reorderElecPhasesSchema>;
