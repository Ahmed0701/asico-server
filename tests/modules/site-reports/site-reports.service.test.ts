import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import {
  InMemorySiteReportsRepository,
  VILLA_FK,
  foreignKeyError,
  siteReportRaces,
  siteReportTables,
} from "./in-memory-site-reports.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { RequestContext } from "../../../src/core/middleware/requestContext.js";
import { SiteReportsService } from "../../../src/modules/site-reports/service/site-reports.service.js";
import type { User } from "../../../src/generated/prisma/client.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe("the site reports service with a clock", () => {
  let admin: User;
  let villa: StoredVilla;
  const actor = () => ({ id: admin.id, role: admin.role });
  const input = (visitDate: string) => ({
    villaId: villa.id,
    title: "First fix check",
    visitDate: day(visitDate),
    inspector: "Eng. Hamdy",
    type: "INSPECTION" as const,
    rating: 4,
    findings: "All good",
  });
  const serviceAt = (now: string, repository = new InMemorySiteReportsRepository()) =>
    new SiteReportsService(repository, () => new Date(now));

  beforeEach(() => {
    store.reset();
    villaTables.reset();
    siteReportRaces.reset();
    siteReportTables.reset();
    admin = store.addUser({
      name: "Root Admin",
      email: "root@example.test",
      passwordHash: "x",
      role: "ADMIN",
    });
    villa = addVilla({ villaNumber: "P-001" });
  });

  it("creates for tomorrow at 23:59:59.999 UTC and refuses the day after, at the same instant", async () => {
    const service = serviceAt("2026-10-27T23:59:59.999Z");

    await expect(service.create(actor(), input("2026-10-28"), ctx)).resolves.toMatchObject({
      visitDate: "2026-10-28",
    });
    await expect(service.create(actor(), input("2026-10-29"), ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      details: [{ path: "visitDate", message: "The visit date cannot be more than one day after today" }],
    });
    expect(siteReportTables.reports).toHaveLength(1);
  });

  it("moves with the clock: the same date is refused one millisecond before midnight and allowed at midnight", async () => {
    await expect(
      serviceAt("2026-10-27T23:59:59.999Z").create(actor(), input("2026-10-29"), ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      serviceAt("2026-10-28T00:00:00.000Z").create(actor(), input("2026-10-29"), ctx),
    ).resolves.toMatchObject({ visitDate: "2026-10-29" });
  });

  it("checks the future date before it takes any lock or touches the villa", async () => {
    const repository = new InMemorySiteReportsRepository();
    const lock = vi.spyOn(repository, "lockVillaShared");
    const service = serviceAt("2026-10-27T10:00:00.000Z", repository);

    await expect(
      service.create(
        actor(),
        { ...input("2026-10-30"), villaId: "00000000-0000-4000-8000-000000000000" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(lock).not.toHaveBeenCalled();
  });

  it("checks a moved date against the clock, and leaves a date that is not moved alone", async () => {
    const creator = serviceAt("2026-10-27T10:00:00.000Z");
    const report = await creator.create(actor(), input("2026-10-28"), ctx);
    const later = serviceAt("2026-10-25T10:00:00.000Z");

    // Two days earlier, the report's own day (3 days ahead) is too far, but it is not being moved.
    await expect(later.update(actor(), report.id, { inspector: "Eng. Sara" }, ctx)).resolves.toMatchObject({
      inspector: "Eng. Sara",
    });
    await expect(
      later.update(actor(), report.id, { visitDate: day("2026-10-28") }, ctx),
    ).resolves.toMatchObject({ visitDate: "2026-10-28" });
    await expect(
      later.update(actor(), report.id, { visitDate: day("2026-10-27") }, ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      later.update(actor(), report.id, { visitDate: day("2026-10-26") }, ctx),
    ).resolves.toMatchObject({ visitDate: "2026-10-26" });
  });

  it("stores no recommendations as null, keeps one it is given, and clears one with null", async () => {
    const service = serviceAt("2026-10-27T10:00:00.000Z");

    const bare = await service.create(actor(), input("2026-10-27"), ctx);
    expect(bare.recommendations).toBeNull();
    expect(siteReportTables.reports[0]!.recommendations).toBeNull();

    const advised = await service.create(
      actor(),
      { ...input("2026-10-27"), recommendations: "Seal it" },
      ctx,
    );
    expect(advised.recommendations).toBe("Seal it");

    await expect(service.update(actor(), advised.id, { recommendations: null }, ctx)).resolves.toMatchObject({
      recommendations: null,
    });
  });

  it("answers 401 when the acting user is gone: nothing written", async () => {
    store.users = store.users.filter((user) => user.id !== admin.id);
    const service = serviceAt("2026-10-27T10:00:00.000Z");

    await expect(service.create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(siteReportTables.reports).toHaveLength(0);
  });

  describe("a write that fails in the database after the checks passed", () => {
    const missingRow = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });
    const at = (repository: InMemorySiteReportsRepository) =>
      serviceAt("2026-10-27T10:00:00.000Z", repository);

    it("answers 404 VILLA_NOT_FOUND when the villa's foreign key fails", async () => {
      const repository = new InMemorySiteReportsRepository();
      vi.spyOn(repository, "create").mockRejectedValue(foreignKeyError(VILLA_FK));

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
      });
    });

    it("lets any other database error through unchanged", async () => {
      const repository = new InMemorySiteReportsRepository();
      const failure = new Error("connection reset");
      vi.spyOn(repository, "create").mockRejectedValue(failure);

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toBe(failure);
    });

    it("answers 404 SITE_REPORT_NOT_FOUND when the row is gone by the time of the update", async () => {
      const report = await at(new InMemorySiteReportsRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySiteReportsRepository();
      vi.spyOn(repository, "update").mockRejectedValue(missingRow());

      await expect(
        at(repository).update(actor(), report.id, { inspector: "Eng. Sara" }, ctx),
      ).rejects.toMatchObject({ statusCode: 404, code: "SITE_REPORT_NOT_FOUND" });
    });

    it("answers 404 SITE_REPORT_NOT_FOUND when the row is gone by the time of the delete", async () => {
      const report = await at(new InMemorySiteReportsRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySiteReportsRepository();
      vi.spyOn(repository, "delete").mockRejectedValue(missingRow());

      await expect(at(repository).remove(actor(), report.id, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "SITE_REPORT_NOT_FOUND",
      });
    });

    it("lets another error of the delete through unchanged", async () => {
      const report = await at(new InMemorySiteReportsRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySiteReportsRepository();
      const failure = new Error("connection reset");
      vi.spyOn(repository, "delete").mockRejectedValue(failure);

      await expect(at(repository).remove(actor(), report.id, ctx)).rejects.toBe(failure);
    });

    it("answers 404 VILLA_NOT_FOUND and writes nothing when the villa lock finds no villa", async () => {
      const repository = new InMemorySiteReportsRepository();
      vi.spyOn(repository, "lockVillaShared").mockResolvedValue(false);
      const create = vi.spyOn(repository, "create");

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
      });
      expect(create).not.toHaveBeenCalled();
    });

    it("answers 404 SITE_REPORT_NOT_FOUND when the row is gone between the lock and the read", async () => {
      const report = await at(new InMemorySiteReportsRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySiteReportsRepository();
      vi.spyOn(repository, "findById").mockResolvedValue(null);

      await expect(
        at(repository).update(actor(), report.id, { inspector: "Eng. Sara" }, ctx),
      ).rejects.toMatchObject({ statusCode: 404, code: "SITE_REPORT_NOT_FOUND" });
    });

    it("reports the version the row has now when a delete finds the row changed", async () => {
      const report = await at(new InMemorySiteReportsRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySiteReportsRepository();
      vi.spyOn(repository, "delete").mockImplementation(async () => {
        siteReportTables.reports[0]!.version = 7;
        return false;
      });

      await expect(at(repository).remove(actor(), report.id, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
        details: [{ path: "version", message: "Current version", value: 7 }],
      });
      expect(siteReportTables.reports).toHaveLength(1);
    });

    it("answers the time the row was last changed, not the time it was made", async () => {
      const service = at(new InMemorySiteReportsRepository());
      const report = await service.create(actor(), input("2026-10-27"), ctx);
      siteReportTables.reports[0]!.createdAt = new Date("2026-01-01T00:00:00.000Z");
      siteReportTables.reports[0]!.updatedAt = new Date("2026-02-02T03:04:05.000Z");

      await expect(service.get(report.id, ctx)).resolves.toMatchObject({
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-02-02T03:04:05.000Z",
      });
    });

    it("does not lock a villa for a site report that does not exist", async () => {
      const repository = new InMemorySiteReportsRepository();
      const lock = vi.spyOn(repository, "lockVillaShared");

      await expect(
        at(repository).update(
          actor(),
          "00000000-0000-4000-8000-000000000000",
          { inspector: "Eng. Sara" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "SITE_REPORT_NOT_FOUND" });
      expect(lock).not.toHaveBeenCalled();
    });

    it("locks the villa before the row on every write to an existing site report", async () => {
      const report = await at(new InMemorySiteReportsRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySiteReportsRepository();
      const order: string[] = [];
      const lockVilla = repository.lockVillaShared.bind(repository);
      const lockRow = repository.lockVersion.bind(repository);
      vi.spyOn(repository, "lockVillaShared").mockImplementation(
        async (id) => (order.push("villa"), lockVilla(id)),
      );
      vi.spyOn(repository, "lockVersion").mockImplementation(async (id) => (order.push("row"), lockRow(id)));

      await at(repository).update(actor(), report.id, { inspector: "Eng. Sara" }, ctx);
      await at(repository).remove(actor(), report.id, ctx);

      expect(order).toEqual(["villa", "row", "villa", "row"]);
    });

    it("reports the version the row has now when the stored version moved after it was read", async () => {
      const report = await at(new InMemorySiteReportsRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySiteReportsRepository();
      // The compare-and-set finds the row changed: the answer carries the version the table has now.
      vi.spyOn(repository, "update").mockImplementation(async () => {
        siteReportTables.reports[0]!.version = 7;
        return null;
      });

      await expect(
        at(repository).update(actor(), report.id, { inspector: "Eng. Sara" }, ctx),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
        details: [{ path: "version", message: "Current version", value: 7 }],
      });
    });

    it("ignores keys of the input that are not fields of a site report", async () => {
      const repository = new InMemorySiteReportsRepository();
      const service = at(repository);
      const report = await service.create(actor(), input("2026-10-27"), ctx);
      const update = vi.spyOn(repository, "update");

      await service.update(
        actor(),
        report.id,
        { inspector: "Eng. Sara", villaId: "x", version: 9 } as unknown as { inspector: string },
        ctx,
      );

      expect(update.mock.calls[0]![2]).toEqual({ inspector: "Eng. Sara" });
    });

    it("passes every field a PATCH can change, and only those", async () => {
      const repository = new InMemorySiteReportsRepository();
      const service = at(repository);
      const report = await service.create(actor(), input("2026-10-27"), ctx);
      const update = vi.spyOn(repository, "update");
      const patch = {
        title: "Second visit",
        visitDate: day("2026-10-26"),
        inspector: "Eng. Sara",
        type: "SAFETY" as const,
        rating: 2,
        findings: "Scaffold loose",
        recommendations: "Tie it",
      };

      await service.update(actor(), report.id, patch, ctx);

      expect(update.mock.calls[0]![2]).toEqual(patch);
    });
  });
});
