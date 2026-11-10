import { z } from "zod";
import { PARTY_STATUSES } from "../constants/enums.js";
import { PERMISSION_CODES, type Permission } from "../constants/permissions.js";

// Messages are translation keys; the validate middleware turns them into the request's language.
export const required = { error: "validation.required" };

export const email = z
  .string(required)
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: "validation.emailInvalid" }));

// bcrypt ignores everything after 72 bytes, so longer passwords are rejected rather than truncated.
export const newPassword = z
  .string(required)
  .min(8, { error: "validation.passwordMin" })
  .refine((value) => Buffer.byteLength(value) <= 72, { error: "validation.passwordMax" });

// An optional contact email: trimmed and lowercased, and null (or blank) means "none". It is not unique: two records
// may share an address. 254 characters is the longest address that can exist.
export const contactEmail = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z
    .string(required)
    .trim()
    .toLowerCase()
    .max(254, { error: "validation.emailTooLong" })
    .pipe(z.email({ error: "validation.emailInvalid" }))
    .nullable(),
);

export const partyStatus = z.enum(PARTY_STATUSES, { error: "validation.partyStatusInvalid" });

// True when an update body carries at least one field. A field set to null counts: it clears the value.
export const hasAnyField = (value: object): boolean =>
  Object.values(value).some((field) => field !== undefined);

export const name = z
  .string(required)
  .trim()
  .min(1, { error: "validation.nameRequired" })
  .max(100, { error: "validation.nameTooLong" });

// The city an area is in.
export const city = z
  .string(required)
  .trim()
  .min(1, { error: "validation.cityRequired" })
  .max(100, { error: "validation.cityTooLong" });

// 5 to 20 characters: an optional leading +, then a digit, then digits, spaces or dashes. Stored as typed.
// One refine, not min/max/regex checks, so a bad value produces a single error.
const PHONE_PATTERN = /^\+?[0-9][0-9 -]*$/;
export const phone = z
  .string(required)
  .trim()
  .refine((value) => value.length >= 5 && value.length <= 20 && PHONE_PATTERN.test(value), {
    error: "validation.phoneInvalid",
  });

const KNOWN_PERMISSIONS = new Set<string>(PERMISSION_CODES);

// A list of known permission codes. Unknown codes are rejected; repeated codes are collapsed.
export const permissionCodes = z
  .array(
    z.custom<Permission>((value) => typeof value === "string" && KNOWN_PERMISSIONS.has(value), {
      error: "validation.permissionInvalid",
    }),
    { error: "validation.invalid" },
  )
  .max(100, { error: "validation.invalid" })
  .transform((codes) => [...new Set(codes)]);

// Route params for `/something/:id`.
export const idParams = z.strictObject({ id: z.uuid({ error: "validation.idInvalid" }) });
