import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import {
  addElectricalEngineer,
  electricalTables,
} from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import {
  CONTRACTOR_FK,
  DAY_UNIQUE,
  ENGINEER_FK,
  InMemoryDailyReportsRepository,
  dailyReportRaces,
  dailyReportTables,
  foreignKeyError,
  uniqueError,
} from "./in-memory-daily-reports.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { RequestContext } from "../../../src/core/middleware/requestContext.js";
import {
  DailyReportsService,
  isTooFarAhead,
} from "../../../src/modules/daily-reports/service/daily-reports.service.js";
import type { User } from "../../../src/generated/prisma/client.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe("isTooFarAhead: a report may be written up to tomorrow (UTC), not beyond", () => {
  it.each([
    ["2026-10-27T00:00:00.000Z", "2026-10-27", false],
    ["2026-10-27T00:00:00.000Z", "2026-10-28", false],
    ["2026-10-27T00:00:00.000Z", "2026-10-29", true],
    ["2026-10-27T23:59:59.999Z", "2026-10-28", false],
    ["2026-10-27T23:59:59.999Z", "2026-10-29", true],
    ["2026-10-28T00:00:00.000Z", "2026-10-29", false],
    ["2026-10-28T00:00:00.000Z", "2026-10-30", true],
    ["2026-10-27T12:00:00.000Z", "2020-01-01", false],
    ["2026-12-31T22:00:00.000Z", "2027-01-01", false],
    ["2026-12-31T22:00:00.000Z", "2027-01-02", true],
    ["2028-02-28T10:00:00.000Z", "2028-02-29", false],
    ["2028-02-28T10:00:00.000Z", "2028-03-01", true],
  ])("at %s the day %s is too far ahead: %s", (now, reportDate, tooFar) => {
    expect(isTooFarAhead(day(reportDate), new Date(now))).toBe(tooFar);
  });
});

describe("the service with a clock", () => {
  let admin: User;
  let contractor: ReturnType<typeof addContractor>;
  let engineer: ReturnType<typeof addElectricalEngineer>;
  const actor = () => ({ id: admin.id, role: admin.role });
  const input = (reportDate: string) => ({
    contractorId: contractor.id,
    preparedByEngineerId: engineer.id,
    reportDate: day(reportDate),
    weather: "SUNNY" as const,
    workersCount: 1,
    notes: "Work",
  });
  const serviceAt = (now: string) =>
    new DailyReportsService(new InMemoryDailyReportsRepository(), () => new Date(now));

  beforeEach(() => {
    store.reset();
    contractorTables.reset();
    electricalTables.reset();
    dailyReportRaces.reset();
    admin = store.addUser({
      name: "Root Admin",
      email: "root@example.test",
      passwordHash: "x",
      role: "ADMIN",
    });
    contractor = addContractor({ name: "Nile Builders" });
    engineer = addElectricalEngineer({ name: "Mona Hassan" });
  });

  it("creates for tomorrow at 23:59:59.999 UTC and refuses the day after, at the same instant", async () => {
    const service = serviceAt("2026-10-27T23:59:59.999Z");

    await expect(service.create(actor(), input("2026-10-28"), ctx)).resolves.toMatchObject({
      reportDate: "2026-10-28",
    });
    await expect(service.create(actor(), input("2026-10-29"), ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      details: [{ path: "reportDate", message: "The report date cannot be more than one day after today" }],
    });
    expect(dailyReportTables.reports).toHaveLength(1);
  });

  it("moves with the clock: the same date is refused one second before midnight and allowed at midnight", async () => {
    await expect(
      serviceAt("2026-10-27T23:59:59.999Z").create(actor(), input("2026-10-29"), ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      serviceAt("2026-10-28T00:00:00.000Z").create(actor(), input("2026-10-29"), ctx),
    ).resolves.toMatchObject({ reportDate: "2026-10-29" });
  });

  it("checks the future date before it takes any lock or touches the contractor", async () => {
    const service = serviceAt("2026-10-27T10:00:00.000Z");

    await expect(
      service.create(
        actor(),
        { ...input("2026-10-30"), contractorId: "00000000-0000-4000-8000-000000000000" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("checks a moved date against the clock, and leaves a date that is not moved alone", async () => {
    const creator = serviceAt("2026-10-27T10:00:00.000Z");
    const report = await creator.create(actor(), input("2026-10-28"), ctx);
    const later = serviceAt("2026-10-25T10:00:00.000Z");

    // Two days earlier, the report's own day (3 days ahead) is too far, but it is not being moved.
    await expect(later.update(actor(), report.id, { workersCount: 2 }, ctx)).resolves.toMatchObject({
      workersCount: 2,
    });
    await expect(
      later.update(actor(), report.id, { reportDate: day("2026-10-28") }, ctx),
    ).resolves.toMatchObject({ reportDate: "2026-10-28" });
    await expect(
      later.update(actor(), report.id, { reportDate: day("2026-10-27") }, ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      later.update(actor(), report.id, { reportDate: day("2026-10-26") }, ctx),
    ).resolves.toMatchObject({ reportDate: "2026-10-26" });
  });

  it("answers the acting user's name when the user is gone: 401, nothing written", async () => {
    store.users = store.users.filter((user) => user.id !== admin.id);
    const service = serviceAt("2026-10-27T10:00:00.000Z");

    await expect(service.create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(dailyReportTables.reports).toHaveLength(0);
  });

  describe("a write that fails in the database after the checks passed", () => {
    const missingRow = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });
    const repo = () => new InMemoryDailyReportsRepository();
    const at = (repository: InMemoryDailyReportsRepository) =>
      new DailyReportsService(repository, () => new Date("2026-10-27T10:00:00.000Z"));

    it("answers 404 ELECTRICAL_ENGINEER_NOT_FOUND when the engineer's foreign key fails, and not the contractor's error", async () => {
      const repository = repo();
      vi.spyOn(repository, "create").mockRejectedValue(foreignKeyError(ENGINEER_FK));

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "ELECTRICAL_ENGINEER_NOT_FOUND",
      });
    });

    it("answers 409 DAILY_REPORT_EXISTS when the unique index of the contractor and the day fails", async () => {
      const repository = repo();
      vi.spyOn(repository, "create").mockRejectedValue(uniqueError(DAY_UNIQUE));

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "DAILY_REPORT_EXISTS",
      });
    });

    it("answers 404 CONTRACTOR_NOT_FOUND when the contractor's foreign key fails", async () => {
      const repository = repo();
      vi.spyOn(repository, "create").mockRejectedValue(foreignKeyError(CONTRACTOR_FK));

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "CONTRACTOR_NOT_FOUND",
      });
    });

    it("lets any other database error through unchanged", async () => {
      const repository = repo();
      const failure = new Error("connection reset");
      vi.spyOn(repository, "create").mockRejectedValue(failure);

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toBe(failure);
    });

    it("answers 404 DAILY_REPORT_NOT_FOUND when the report is gone by the time of the update", async () => {
      const service = at(repo());
      const report = await service.create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      vi.spyOn(repository, "update").mockRejectedValue(missingRow());

      await expect(at(repository).update(actor(), report.id, { workersCount: 2 }, ctx)).rejects.toMatchObject(
        {
          statusCode: 404,
          code: "DAILY_REPORT_NOT_FOUND",
        },
      );
    });

    it("answers 404 DAILY_REPORT_NOT_FOUND when the report is gone by the time of the delete", async () => {
      const service = at(repo());
      const report = await service.create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      vi.spyOn(repository, "delete").mockRejectedValue(missingRow());

      await expect(at(repository).remove(actor(), report.id, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "DAILY_REPORT_NOT_FOUND",
      });
    });

    it("lets another error of the delete through unchanged", async () => {
      const service = at(repo());
      const report = await service.create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      const failure = new Error("connection reset");
      vi.spyOn(repository, "delete").mockRejectedValue(failure);

      await expect(at(repository).remove(actor(), report.id, ctx)).rejects.toBe(failure);
    });

    it("does not look at a contractor or an engineer for a report that does not exist", async () => {
      const repository = repo();
      const contractorLookup = vi.spyOn(repository, "contractorStatus");
      const engineerLookup = vi.spyOn(repository, "engineerStatus");

      await expect(
        at(repository).update(
          actor(),
          "00000000-0000-4000-8000-000000000000",
          { contractorId: contractor.id, preparedByEngineerId: engineer.id },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "DAILY_REPORT_NOT_FOUND" });
      expect(contractorLookup).not.toHaveBeenCalled();
      expect(engineerLookup).not.toHaveBeenCalled();
    });

    it("reports the version the report has now when the stored version moved after it was read", async () => {
      const service = at(repo());
      const report = await service.create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      // The compare-and-set finds the report changed: the answer carries the version the table has now.
      vi.spyOn(repository, "update").mockImplementation(async () => {
        dailyReportTables.reports[0]!.version = 7;
        return null;
      });

      await expect(at(repository).update(actor(), report.id, { workersCount: 2 }, ctx)).rejects.toMatchObject(
        {
          statusCode: 409,
          code: "VERSION_CONFLICT",
          details: [{ path: "version", message: "Current version", value: 7 }],
        },
      );
    });

    it("ignores keys of the input that are not fields of a report", async () => {
      const repository = repo();
      const service = at(repository);
      const report = await service.create(actor(), input("2026-10-27"), ctx);
      const update = vi.spyOn(repository, "update");

      await service.update(
        actor(),
        report.id,
        { workersCount: 2, villaId: "x", workDone: "y", version: 9 } as unknown as { workersCount: number },
        ctx,
      );

      expect(update.mock.calls[0]![2]).toEqual({ workersCount: 2 });
    });
  });
});
