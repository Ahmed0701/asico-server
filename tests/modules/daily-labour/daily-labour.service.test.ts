import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import {
  CONTRACTOR_FK,
  InMemoryDailyLabourRepository,
  KEY_UNIQUE,
  VILLA_FK,
  dailyLabourRaces,
  dailyLabourTables,
  foreignKeyError,
  uniqueError,
} from "./in-memory-daily-labour.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { RequestContext } from "../../../src/core/middleware/requestContext.js";
import { DailyLabourService } from "../../../src/modules/daily-labour/service/daily-labour.service.js";
import type { User } from "../../../src/generated/prisma/client.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe("the service with a clock", () => {
  let admin: User;
  let villa: StoredVilla;
  let nile: ReturnType<typeof addContractor>;
  const actor = () => ({ id: admin.id, role: admin.role });
  const input = (labourDate: string) => ({
    villaId: villa.id,
    labourDate: day(labourDate),
    contractorId: nile.id,
    labourCount: 1,
  });
  const serviceAt = (now: string) =>
    new DailyLabourService(new InMemoryDailyLabourRepository(), () => new Date(now));

  beforeEach(() => {
    store.reset();
    engineerTables.reset();
    contractorTables.reset();
    villaTables.reset();
    dailyLabourRaces.reset();
    admin = store.addUser({
      name: "Root Admin",
      email: "root@example.test",
      passwordHash: "x",
      role: "ADMIN",
    });
    addEngineer({ name: "Mona Hassan" });
    nile = addContractor({ name: "Nile Builders" });
    villa = addVilla({ villaNumber: "P-001", contractorId: nile.id });
  });

  it("creates for tomorrow at 23:59:59.999 UTC and refuses the day after, at the same instant", async () => {
    const service = serviceAt("2026-10-27T23:59:59.999Z");

    await expect(service.create(actor(), input("2026-10-28"), ctx)).resolves.toMatchObject({
      labourDate: "2026-10-28",
    });
    await expect(service.create(actor(), input("2026-10-29"), ctx)).rejects.toMatchObject({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      details: [{ path: "labourDate", message: "The labour date cannot be more than one day after today" }],
    });
    expect(dailyLabourTables.rows).toHaveLength(1);
  });

  it("moves with the clock: the same date is refused one millisecond before midnight and allowed at midnight", async () => {
    await expect(
      serviceAt("2026-10-27T23:59:59.999Z").create(actor(), input("2026-10-29"), ctx),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      serviceAt("2026-10-28T00:00:00.000Z").create(actor(), input("2026-10-29"), ctx),
    ).resolves.toMatchObject({ labourDate: "2026-10-29" });
  });

  it("checks the future date before it takes any lock or touches the villa", async () => {
    const service = serviceAt("2026-10-27T10:00:00.000Z");

    await expect(
      service.create(
        actor(),
        { ...input("2026-10-30"), villaId: "00000000-0000-4000-8000-000000000000" },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("checks a moved date against the clock, and leaves a date that is not moved alone", async () => {
    const creator = serviceAt("2026-10-27T10:00:00.000Z");
    const row = await creator.create(actor(), input("2026-10-28"), ctx);
    const later = serviceAt("2026-10-25T10:00:00.000Z");

    // Two days earlier, the row's own day (3 days ahead) is too far, but it is not being moved.
    await expect(later.update(actor(), row.id, { labourCount: 2 }, ctx)).resolves.toMatchObject({
      labourCount: 2,
    });
    await expect(
      later.update(actor(), row.id, { labourDate: day("2026-10-28") }, ctx),
    ).resolves.toMatchObject({ labourDate: "2026-10-28" });
    await expect(later.update(actor(), row.id, { labourDate: day("2026-10-27") }, ctx)).rejects.toMatchObject(
      { code: "VALIDATION_ERROR" },
    );
    await expect(
      later.update(actor(), row.id, { labourDate: day("2026-10-26") }, ctx),
    ).resolves.toMatchObject({ labourDate: "2026-10-26" });
  });

  describe("a write that fails in the database after the checks passed", () => {
    const missingRow = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });
    const repo = () => new InMemoryDailyLabourRepository();
    const at = (repository: InMemoryDailyLabourRepository) =>
      new DailyLabourService(repository, () => new Date("2026-10-27T10:00:00.000Z"));

    it("answers 404 VILLA_NOT_FOUND when the villa's foreign key fails, and not the contractor's error", async () => {
      const repository = repo();
      vi.spyOn(repository, "create").mockRejectedValue(foreignKeyError(VILLA_FK));

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
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

    it("answers 409 DAILY_LABOUR_EXISTS when the unique index fails, whichever way the driver names it", async () => {
      for (const failure of [
        uniqueError(KEY_UNIQUE),
        Object.assign(new Error("Prisma P2002"), {
          code: "P2002",
          meta: { target: ["villaId", "contractorId", "labourDate"] },
        }),
      ]) {
        const repository = repo();
        vi.spyOn(repository, "create").mockRejectedValue(failure);

        await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
          statusCode: 409,
          code: "DAILY_LABOUR_EXISTS",
        });
      }
    });

    it("lets a unique violation of anything else through unchanged", async () => {
      const repository = repo();
      const failure = uniqueError("DailyLabour_pkey");
      vi.spyOn(repository, "create").mockRejectedValue(failure);

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toBe(failure);
    });

    it("lets any other database error through unchanged", async () => {
      const repository = repo();
      const failure = new Error("connection reset");
      vi.spyOn(repository, "create").mockRejectedValue(failure);

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toBe(failure);
    });

    it("answers 404 DAILY_LABOUR_NOT_FOUND when the row is gone by the time of the update", async () => {
      const row = await at(repo()).create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      vi.spyOn(repository, "update").mockRejectedValue(missingRow());

      await expect(at(repository).update(actor(), row.id, { labourCount: 2 }, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "DAILY_LABOUR_NOT_FOUND",
      });
    });

    it("answers 409 DAILY_LABOUR_EXISTS when the unique index fails on an update", async () => {
      const row = await at(repo()).create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      vi.spyOn(repository, "update").mockRejectedValue(uniqueError(KEY_UNIQUE));

      await expect(
        at(repository).update(actor(), row.id, { labourDate: day("2026-10-26") }, ctx),
      ).rejects.toMatchObject({ statusCode: 409, code: "DAILY_LABOUR_EXISTS" });
    });

    it("answers 404 DAILY_LABOUR_NOT_FOUND when the row is gone by the time of the delete", async () => {
      const row = await at(repo()).create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      vi.spyOn(repository, "delete").mockRejectedValue(missingRow());

      await expect(at(repository).remove(actor(), row.id, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "DAILY_LABOUR_NOT_FOUND",
      });
    });

    it("lets another error of the delete through unchanged", async () => {
      const row = await at(repo()).create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      const failure = new Error("connection reset");
      vi.spyOn(repository, "delete").mockRejectedValue(failure);

      await expect(at(repository).remove(actor(), row.id, ctx)).rejects.toBe(failure);
    });

    it("does not lock a villa for a row that does not exist", async () => {
      const repository = repo();
      const lock = vi.spyOn(repository, "lockVillaShared");

      await expect(
        at(repository).update(actor(), "00000000-0000-4000-8000-000000000000", { labourCount: 2 }, ctx),
      ).rejects.toMatchObject({ code: "DAILY_LABOUR_NOT_FOUND" });
      expect(lock).not.toHaveBeenCalled();
    });

    it("reports the version the row has now when the stored version moved after it was read", async () => {
      const row = await at(repo()).create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      // The compare-and-set finds the row changed: the answer carries the version the table has now.
      vi.spyOn(repository, "update").mockImplementation(async () => {
        dailyLabourTables.rows[0]!.version = 7;
        return null;
      });

      await expect(at(repository).update(actor(), row.id, { labourCount: 2 }, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
        details: [{ path: "version", message: "Current version", value: 7 }],
      });
    });

    it("reports the version the row has now when the stored version moved before the delete", async () => {
      const row = await at(repo()).create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      vi.spyOn(repository, "delete").mockImplementation(async () => {
        dailyLabourTables.rows[0]!.version = 8;
        return false;
      });

      await expect(at(repository).remove(actor(), row.id, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
        details: [{ path: "version", message: "Current version", value: 8 }],
      });
    });

    it("answers 404 when the row vanishes between the lock and the read", async () => {
      const row = await at(repo()).create(actor(), input("2026-10-27"), ctx);
      const repository = repo();
      vi.spyOn(repository, "findById").mockResolvedValue(null);

      await expect(at(repository).update(actor(), row.id, { labourCount: 2 }, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "DAILY_LABOUR_NOT_FOUND",
      });
    });

    it("lists newest day first when no sort is asked, and passes the sort that is", async () => {
      const repository = repo();
      const list = vi.spyOn(repository, "list");

      await at(repository).list({ page: 1, limit: 20 } as never);
      await at(repository).list({ page: 1, limit: 20, sort: "labourCount:asc" } as never);

      expect(list.mock.calls[0]![0].sort).toEqual({ field: "labourDate", direction: "desc" });
      expect(list.mock.calls[1]![0].sort).toEqual({ field: "labourCount", direction: "asc" });
    });

    it("ignores keys of the input that are not fields of a labour row", async () => {
      const repository = repo();
      const service = at(repository);
      const row = await service.create(actor(), input("2026-10-27"), ctx);
      const update = vi.spyOn(repository, "update");

      await service.update(
        actor(),
        row.id,
        { labourCount: 2, villaId: "x", version: 9 } as unknown as { labourCount: number },
        ctx,
      );

      expect(update.mock.calls[0]![2]).toEqual({ labourCount: 2 });
    });

    it("sends the whole change to the table: the day, the contractor, the count and the notes", async () => {
      const repository = repo();
      const service = at(repository);
      const row = await service.create(actor(), input("2026-10-27"), ctx);
      const update = vi.spyOn(repository, "update");

      await service.update(
        actor(),
        row.id,
        { labourDate: day("2026-10-20"), contractorId: nile.id, labourCount: 4, notes: "n" },
        ctx,
      );

      expect(update.mock.calls[0]![2]).toEqual({
        labourDate: day("2026-10-20"),
        contractorId: nile.id,
        labourCount: 4,
        notes: "n",
      });
    });

    it("checks the contractor of an update only when the request changes it", async () => {
      const repository = repo();
      const service = at(repository);
      const row = await service.create(actor(), input("2026-10-27"), ctx);
      const status = vi.spyOn(repository, "contractorStatus");

      await service.update(actor(), row.id, { labourCount: 2 }, ctx);
      await service.update(actor(), row.id, { contractorId: nile.id }, ctx);

      expect(status).not.toHaveBeenCalled();
    });
  });
});
