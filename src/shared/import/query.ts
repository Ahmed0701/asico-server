import { z } from "zod";

// `?dryRun=true` validates the file and reports, and writes nothing.
export const importQuerySchema = z.strictObject({
  dryRun: z
    .enum(["true", "false"], { error: "validation.booleanInvalid" })
    .default("false")
    .transform((value) => value === "true"),
});

export type ImportQuery = z.output<typeof importQuerySchema>;
