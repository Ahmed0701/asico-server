import { z } from "zod";
import { MAX_REPORT_VILLAS } from "../dto/mew-inspection-reports.dto.js";

const uuid = z.uuid({ error: "validation.idInvalid" });

export const villaReportParams = z.strictObject({ villaId: uuid });

// villaIds=a,b,c: the villas of one page, at most MAX_REPORT_VILLAS.
export const reportsQuerySchema = z.strictObject({
  villaIds: z
    .string({ error: "validation.required" })
    .transform((value) =>
      value
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(z.array(uuid).max(MAX_REPORT_VILLAS, { error: "validation.tooManyIds" })),
});

export type ReportsQuery = z.output<typeof reportsQuerySchema>;
