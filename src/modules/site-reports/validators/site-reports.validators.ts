import { z } from "zod";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { calendarDateField } from "../../../shared/validation/dates.js";
import { hasAnyField, required } from "../../../shared/validation/fields.js";
import {
  MAX_INSPECTOR_LENGTH,
  MAX_RATING,
  MAX_REPORT_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_RATING,
  SITE_REPORT_SORT_FIELDS,
  SITE_REPORT_TYPES,
} from "../dto/site-reports.dto.js";

// "visitDate", "visitDate:asc" or "rating:desc", for the whitelisted fields only.
const sortPattern = new RegExp(`^(${SITE_REPORT_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));
const queryId = z.uuid({ error: "validation.idInvalid" });

// The type, the rating and the four texts are also what a cell of the import file must hold.
export const type = z.enum(SITE_REPORT_TYPES, { error: "validation.siteReportTypeInvalid" });

// A whole number from 1 to 5. One refine, so every bad value gives one error: 0, 6, 2.5 and NaN are all a 400.
export const rating = z
  .number({ error: "validation.ratingInvalid" })
  .refine((value) => Number.isInteger(value) && value >= MIN_RATING && value <= MAX_RATING, {
    error: "validation.ratingInvalid",
  });

export const title = z
  .string(required)
  .trim()
  .min(1, { error: "validation.siteReportTitleLength" })
  .max(MAX_TITLE_LENGTH, { error: "validation.siteReportTitleLength" });

export const inspector = z
  .string(required)
  .trim()
  .min(1, { error: "validation.inspectorLength" })
  .max(MAX_INSPECTOR_LENGTH, { error: "validation.inspectorLength" });

export const findings = z
  .string(required)
  .trim()
  .min(1, { error: "validation.findingsLength" })
  .max(MAX_REPORT_TEXT_LENGTH, { error: "validation.findingsLength" });

// Blank means "no recommendations": it is stored as null.
export const recommendations = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string(required)
    .trim()
    .max(MAX_REPORT_TEXT_LENGTH, { error: "validation.recommendationsTooLong" })
    .nullable(),
);

// The villa is fixed when a site report is made: a PATCH carrying villaId is refused as an unknown field.
export const createSiteReportSchema = z.strictObject({
  villaId: id,
  title,
  visitDate: calendarDateField,
  inspector,
  type,
  rating,
  findings,
  recommendations: recommendations.optional(),
});

// No defaults here: a field that is not sent must stay as it is.
export const updateSiteReportSchema = z
  .strictObject({
    title: title.optional(),
    visitDate: calendarDateField.optional(),
    inspector: inspector.optional(),
    type: type.optional(),
    rating: rating.optional(),
    findings: findings.optional(),
    recommendations: recommendations.optional(),
  })
  .refine(hasAnyField, { error: "validation.atLeastOneField" });

export const listSiteReportsQuerySchema = paginationQuerySchema
  .extend({
    sort: z.string().regex(sortPattern, { error: "validation.sortSiteReportsInvalid" }).optional(),
    villaId: queryId.optional(),
    type: type.optional(),
    // The query is text: "3" is the rating 3, and anything else is refused.
    rating: z
      .string()
      .regex(/^[1-5]$/, { error: "validation.ratingInvalid" })
      .transform(Number)
      .optional(),
    visitFrom: calendarDateField.optional(),
    visitTo: calendarDateField.optional(),
    search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
  })
  .refine((query) => !query.visitFrom || !query.visitTo || query.visitFrom <= query.visitTo, {
    error: "validation.dateRangeInvalid",
    path: ["visitTo"],
  });

export type CreateSiteReportInput = z.output<typeof createSiteReportSchema>;
export type UpdateSiteReportInput = z.output<typeof updateSiteReportSchema>;
export type ListSiteReportsQuery = z.output<typeof listSiteReportsQuerySchema>;
