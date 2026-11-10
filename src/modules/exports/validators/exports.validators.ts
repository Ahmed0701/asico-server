import { z } from "zod";
import { MAX_LIMIT } from "../../../shared/query/pagination.js";
import type { ExportFormat } from "../../../shared/export/types.js";

const format = z.enum(["xlsx", "pdf"], { error: "validation.formatInvalid" });

// An export takes what the list endpoint takes, minus the paging. Nothing is redefined here: the module's own
// list schema checks every filter, sort and date, so the two cannot drift apart. The paging that schema needs
// is supplied internally (the first page at the biggest size), and a client may not send its own.
export type ParsedExport<Query> = { format: ExportFormat; query: Query };

const PAGING = ["page", "limit"] as const;

export function exportQuery<Schema extends z.ZodType>(listSchema: Schema) {
  return z.record(z.string(), z.unknown()).transform((raw, ctx): ParsedExport<z.output<Schema>> => {
    let valid = true;

    const chosen = format.safeParse(raw["format"]);
    if (!chosen.success) {
      ctx.issues.push({
        code: "custom",
        message: "validation.formatInvalid",
        path: ["format"],
        input: raw["format"],
      });
      valid = false;
    }
    for (const key of PAGING) {
      if (key in raw) {
        ctx.issues.push({
          code: "custom",
          message: "validation.paginationNotAllowed",
          path: [key],
          input: raw[key],
        });
        valid = false;
      }
    }

    const filters = Object.fromEntries(
      Object.entries(raw).filter(([key]) => key !== "format" && key !== "page" && key !== "limit"),
    );
    const listed = listSchema.safeParse({ ...filters, page: "1", limit: String(MAX_LIMIT) });
    if (!listed.success) {
      for (const issue of listed.error.issues) {
        ctx.issues.push({ code: "custom", message: issue.message, path: issue.path, input: raw });
      }
      valid = false;
    }

    if (!valid || !chosen.success || !listed.success) {
      return z.NEVER;
    }
    return { format: chosen.data, query: listed.data };
  });
}
