import type { NextFunction, Request, Response } from "express";
import { Prisma } from "../../generated/prisma/client.js";
import type { LocaleCode } from "../../shared/constants/enums.js";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";

// Optimistic concurrency. Every row people edit carries an integer `version`, which starts at 1 and goes up by one with
// every write. A client that sends the version it read as `If-Match` is refused (409 VERSION_CONFLICT) if the row has
// moved on, so it cannot overwrite a change it never saw. The header is optional: without it a write goes through.

export const VERSIONED_TABLES = [
  "User",
  "Villa",
  "Contractor",
  "CivilEngineer",
  "ElectricalEngineer",
  "ElecPhase",
  "Area",
  "WorkItem",
  "DailyReport",
  "DailySmallWork",
  "SiteReport",
  "DailyLabour",
  "MaintenanceVilla",
  "Factory",
  "MaterialDelivery",
  "MaterialItem",
] as const;
export type VersionedTable = (typeof VERSIONED_TABLES)[number];

const MAX_VERSION = 2_147_483_647;
// 3, "3", W/"3": the version as a plain number, quoted, or as a weak entity tag.
const IF_MATCH = /^(?:W\/)?"?(\d{1,10})"?$/;

export type IfMatch =
  { kind: "none" } | { kind: "any" } | { kind: "version"; version: number } | { kind: "invalid" };

export function parseIfMatch(header: string | undefined): IfMatch {
  if (header === undefined) {
    return { kind: "none" };
  }
  const value = header.trim();
  if (value === "*") {
    return { kind: "any" };
  }
  const match = IF_MATCH.exec(value);
  const version = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isSafeInteger(version) && version >= 1 && version <= MAX_VERSION
    ? { kind: "version", version }
    : { kind: "invalid" };
}

// Reads If-Match into `req.expectedVersion` (undefined when the header is absent or `*`). With `required` a missing
// header is refused (428), for the routes that will insist on it.
export function ifMatch(options: { required?: boolean } = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.headers["if-match"];
    const parsed = parseIfMatch(typeof header === "string" ? header : undefined);
    if (parsed.kind === "invalid") {
      next(new AppError(400, t(req.locale, "errors.invalidIfMatch"), "INVALID_IF_MATCH"));
      return;
    }
    if (parsed.kind === "none" && options.required) {
      next(new AppError(428, t(req.locale, "errors.ifMatchRequired"), "IF_MATCH_REQUIRED"));
      return;
    }
    if (parsed.kind === "version") {
      req.expectedVersion = parsed.version;
    }
    next();
  };
}

// The 409 a stale write gets. The current version is in the details, so the client can tell what it is up against.
export function versionConflict(locale: LocaleCode, current: number): AppError {
  return new AppError(409, t(locale, "errors.versionConflict"), "VERSION_CONFLICT", [
    { path: "version", message: t(locale, "errors.versionCurrent"), value: current },
  ]);
}

// Throws when the caller named a version and it is not the current one.
export function assertVersion(locale: LocaleCode, expected: number | undefined, current: number): void {
  if (expected !== undefined && expected !== current) {
    throw versionConflict(locale, current);
  }
}

// Locks the row until the transaction ends and returns its version, or null when it does not exist. Writers of one row
// take turns, so what a transaction reads here is what it then changes (and what the audit entry records as "before").
export async function lockVersion(
  db: Prisma.TransactionClient,
  table: VersionedTable,
  id: string,
): Promise<number | null> {
  const rows = await db.$queryRaw<{ version: number }[]>(
    Prisma.sql`SELECT "version" FROM ${Prisma.raw(`"${table}"`)} WHERE "id" = ${id} FOR UPDATE`,
  );
  return rows[0]?.version ?? null;
}

// The ETag of a single item, for standard HTTP clients: its version, quoted.
export function etagOf(version: number): string {
  return `"${version}"`;
}

// Sets the headers of a response that carries a row's version: the ETag (for If-Match on the next write) and
// `Cache-Control: private, no-store`. The version says only whether THAT ROW was written. The body of a detail also holds
// what other tables decide (a villa's phases and progress, a contractor's villa count, the names of linked records, an
// "overdue" flag that follows the clock), and those change without the row's version moving. So the ETag must never serve
// as a cache validator: a conditional GET is always answered with the full, current body (200, never 304), including
// from a browser that cached the page before this rule and still sends If-None-Match. Call it instead of setting
// the header by hand.
export function setVersionHeaders(res: Response, version: number): void {
  res.setHeader("ETag", etagOf(version));
  res.setHeader("Cache-Control", "private, no-store");
  // Express answers 304 when this matches the ETag of the response; without it there is nothing to compare. (A response
  // with no Last-Modified is never fresh by If-Modified-Since, so that header needs no care.)
  delete res.req.headers["if-none-match"];
}
