import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import {
  CONTRACTOR_FK,
  InMemorySmallWorksRepository,
  VILLA_FK,
  addSmallWork,
  foreignKeyError,
  smallWorkRaces,
  smallWorkTables,
} from "./in-memory-small-works.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { RequestContext } from "../../../src/core/middleware/requestContext.js";
import { SmallWorksService } from "../../../src/modules/small-works/service/small-works.service.js";
import type { User } from "../../../src/generated/prisma/client.js";
import type { DeadlinePolicy } from "../../../src/shared/utils/deadline.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const KUWAIT: DeadlinePolicy = { timeZone: "Asia/Kuwait", hoursBefore: 8 };

describe("the small works service with a clock", () => {
  let admin: User;
  let villa: StoredVilla;
  let contractorId: string;
  const actor = () => ({ id: admin.id, role: admin.role });
  const input = (startDate: string, endDate = startDate) => ({
    villaId: villa.id,
    contractorId,
    startDate: day(startDate),
    endDate: day(endDate),
    description: "Work",
  });
  const serviceAt = (
    now: string,
    repository = new InMemorySmallWorksRepository(),
    policy: DeadlinePolicy = KUWAIT,
  ) => new SmallWorksService(repository, () => new Date(now), policy);

  beforeEach(() => {
    store.reset();
    villaTables.reset();
    contractorTables.reset();
    smallWorkRaces.reset();
    smallWorkTables.reset();
    admin = store.addUser({
      name: "Root Admin",
      email: "root@example.test",
      passwordHash: "x",
      role: "ADMIN",
    });
    villa = addVilla({ villaNumber: "P-001" });
    contractorId = addContractor({ name: "Nile Builders" }).id;
  });

  it("answers the contractor as { id, name } and the range as two days", async () => {
    const service = serviceAt("2026-10-27T10:00:00.000Z");

    await expect(service.create(actor(), input("2026-10-27", "2026-10-30"), ctx)).resolves.toMatchObject({
      contractor: { id: contractorId, name: "Nile Builders" },
      startDate: "2026-10-27",
      endDate: "2026-10-30",
    });
  });

  describe("the contractor", () => {
    it("may be any active contractor, not the villa's own", async () => {
      const own = addContractor({ name: "Own Co" });
      villa.contractorId = own.id;
      const service = serviceAt("2026-10-27T10:00:00.000Z");

      await expect(service.create(actor(), input("2026-10-27"), ctx)).resolves.toMatchObject({
        contractor: { name: "Nile Builders" },
      });
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for one that does not exist, and writes nothing", async () => {
      const service = serviceAt("2026-10-27T10:00:00.000Z");

      await expect(
        service.create(
          actor(),
          { ...input("2026-10-27"), contractorId: "00000000-0000-4000-8000-000000000000" },
          ctx,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: "CONTRACTOR_NOT_FOUND" });
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it("answers 400 CONTRACTOR_INACTIVE for an inactive one, and writes nothing", async () => {
      const inactive = addContractor({ name: "Off Co", status: "INACTIVE" });
      const service = serviceAt("2026-10-27T10:00:00.000Z");

      await expect(
        service.create(actor(), { ...input("2026-10-27"), contractorId: inactive.id }, ctx),
      ).rejects.toMatchObject({
        statusCode: 400,
        code: "CONTRACTOR_INACTIVE",
        message: "This contractor is inactive and cannot be given a daily small work",
      });
      expect(smallWorkTables.works).toHaveLength(0);
    });

    it("is checked on an update only when the update changes it: an inactive contractor already on the row stays saveable", async () => {
      const service = serviceAt("2026-10-27T10:00:00.000Z");
      const work = await service.create(actor(), input("2026-10-27"), ctx);
      contractorTables.contractors[0]!.status = "INACTIVE";

      await expect(service.update(actor(), work.id, { description: "Changed" }, ctx)).resolves.toMatchObject({
        description: "Changed",
      });
      await expect(service.update(actor(), work.id, { contractorId }, ctx)).resolves.toMatchObject({
        contractor: { id: contractorId },
      });
    });

    it("can be changed to another active contractor, and refuses an inactive or unknown one on an update", async () => {
      const service = serviceAt("2026-10-27T10:00:00.000Z");
      const work = await service.create(actor(), input("2026-10-27"), ctx);
      const other = addContractor({ name: "Delta Co" });
      const inactive = addContractor({ name: "Off Co", status: "INACTIVE" });

      await expect(service.update(actor(), work.id, { contractorId: other.id }, ctx)).resolves.toMatchObject({
        contractor: { id: other.id, name: "Delta Co" },
      });
      await expect(
        service.update(actor(), work.id, { contractorId: inactive.id }, ctx),
      ).rejects.toMatchObject({ statusCode: 400, code: "CONTRACTOR_INACTIVE" });
      await expect(
        service.update(actor(), work.id, { contractorId: "00000000-0000-4000-8000-000000000000" }, ctx),
      ).rejects.toMatchObject({ statusCode: 404, code: "CONTRACTOR_NOT_FOUND" });
      expect(smallWorkTables.works[0]!.contractorId).toBe(other.id);
    });

    it("answers 404 CONTRACTOR_NOT_FOUND when the contractor's foreign key fails (it was deleted after the check)", async () => {
      const repository = new InMemorySmallWorksRepository();
      vi.spyOn(repository, "create").mockRejectedValue(foreignKeyError(CONTRACTOR_FK));

      await expect(
        serviceAt("2026-10-27T10:00:00.000Z", repository).create(actor(), input("2026-10-27"), ctx),
      ).rejects.toMatchObject({ statusCode: 404, code: "CONTRACTOR_NOT_FOUND" });
    });
  });

  describe("the range of days", () => {
    const service = () => serviceAt("2026-10-27T10:00:00.000Z");

    it("accepts one day (the start equals the end) and refuses a range that runs backwards with 422", async () => {
      await expect(service().create(actor(), input("2026-11-05", "2026-11-05"), ctx)).resolves.toMatchObject({
        startDate: "2026-11-05",
        endDate: "2026-11-05",
      });
      await expect(service().create(actor(), input("2026-11-06", "2026-11-05"), ctx)).rejects.toMatchObject({
        statusCode: 422,
        code: "SMALL_WORK_DATE_RANGE_INVALID",
        message: "The end date cannot be before the start date",
      });
      expect(smallWorkTables.works).toHaveLength(1);
    });

    it("has no future rule: a work planned for next year is fine, and so is one in the past", async () => {
      await expect(service().create(actor(), input("2027-10-27", "2027-12-01"), ctx)).resolves.toMatchObject({
        endDate: "2027-12-01",
      });
      await expect(service().create(actor(), input("2026-01-01", "2026-01-02"), ctx)).resolves.toMatchObject({
        startDate: "2026-01-01",
      });
    });

    it("bounds both dates to 10 years around today: the last day is accepted and the day after is a 400 on that field", async () => {
      // Today is 2026-10-27 (UTC): the bound is 2016-10-27 to 2036-10-27.
      await expect(service().create(actor(), input("2036-10-27"), ctx)).resolves.toMatchObject({
        startDate: "2036-10-27",
      });
      await expect(service().create(actor(), input("2016-10-27"), ctx)).resolves.toMatchObject({
        startDate: "2016-10-27",
      });
      await expect(service().create(actor(), input("2036-10-28"), ctx)).rejects.toMatchObject({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        details: [{ path: "startDate", message: "The date must be within 10 years of today" }],
      });
      await expect(service().create(actor(), input("2016-10-26"), ctx)).rejects.toMatchObject({
        details: [{ path: "startDate" }],
      });
      await expect(service().create(actor(), input("2026-10-27", "2036-10-28"), ctx)).rejects.toMatchObject({
        details: [{ path: "endDate", message: "The date must be within 10 years of today" }],
      });
      expect(smallWorkTables.works).toHaveLength(2);
    });

    it("checks the bound before it takes any lock or touches the villa", async () => {
      const repository = new InMemorySmallWorksRepository();
      const lock = vi.spyOn(repository, "lockVillaShared");

      await expect(
        serviceAt("2026-10-27T10:00:00.000Z", repository).create(
          actor(),
          { ...input("2040-01-01"), villaId: "00000000-0000-4000-8000-000000000000" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(lock).not.toHaveBeenCalled();
    });

    it("on an update, checks the order against the other date as it is stored", async () => {
      const work = await service().create(actor(), input("2026-11-10", "2026-11-12"), ctx);

      await expect(
        service().update(actor(), work.id, { endDate: day("2026-11-09") }, ctx),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: "SMALL_WORK_DATE_RANGE_INVALID",
      });
      await expect(
        service().update(actor(), work.id, { startDate: day("2026-11-13") }, ctx),
      ).rejects.toMatchObject({
        statusCode: 422,
      });
      await expect(
        service().update(actor(), work.id, { endDate: day("2026-11-10") }, ctx),
      ).resolves.toMatchObject({
        startDate: "2026-11-10",
        endDate: "2026-11-10",
      });
      // Both at once are checked as a pair.
      await expect(
        service().update(actor(), work.id, { startDate: day("2026-12-01"), endDate: day("2026-12-03") }, ctx),
      ).resolves.toMatchObject({ startDate: "2026-12-01", endDate: "2026-12-03" });
    });

    it("on an update, checks the bound only for a date the request moves", async () => {
      const work = await serviceAt("2026-10-27T10:00:00.000Z").create(actor(), input("2036-10-27"), ctx);
      // Ten years and a day later the stored date is out of the bound, but it is not being moved.
      const later = serviceAt("2026-10-28T10:00:00.000Z");
      await expect(later.update(actor(), work.id, { description: "Changed" }, ctx)).resolves.toMatchObject({
        description: "Changed",
      });
      await expect(
        later.update(actor(), work.id, { startDate: day("2036-10-27") }, ctx),
      ).resolves.toMatchObject({
        startDate: "2036-10-27",
      });
      await expect(later.update(actor(), work.id, { endDate: day("2040-01-01") }, ctx)).rejects.toMatchObject(
        {
          details: [{ path: "endDate" }],
        },
      );
    });
  });

  describe("a date the request sends back unchanged", () => {
    it("is not bounded again, even if the clock now puts it out of the bound", async () => {
      const work = await serviceAt("2026-10-27T10:00:00.000Z").create(actor(), input("2036-10-27"), ctx);
      // A day earlier, 2036-10-27 is one day past the upper bound; sending the stored value back changes nothing.
      const earlier = serviceAt("2026-10-26T10:00:00.000Z");

      await expect(
        earlier.update(actor(), work.id, { startDate: day("2036-10-27"), description: "Changed" }, ctx),
      ).resolves.toMatchObject({ startDate: "2036-10-27", description: "Changed" });
      await expect(
        earlier.update(actor(), work.id, { endDate: day("2036-10-27") }, ctx),
      ).resolves.toMatchObject({ endDate: "2036-10-27" });
    });
  });

  describe("overdue and due soon, in the application's time zone", () => {
    // endDate 2026-11-05 in Asia/Kuwait (UTC+3, no daylight saving): due soon from 16:00 local = 13:00Z on the 5th, overdue from
    // 00:00 local on the 6th = 21:00Z on the 5th.
    const flagsAt = async (
      now: string,
      status: "PENDING" | "DONE" = "PENDING",
      policy = KUWAIT,
      endDate = "2026-11-05",
    ) => {
      smallWorkTables.reset();
      const stored = addSmallWork({
        villaId: villa.id,
        contractorId,
        startDate: day("2026-11-01"),
        endDate: day(endDate),
        status,
      });
      const dto = await serviceAt(now, new InMemorySmallWorksRepository(), policy).get(stored.id, ctx);
      return { overdue: dto.overdue, dueSoon: dto.dueSoon, deadlineAt: dto.deadlineAt };
    };

    it.each([
      ["a day before the alert window", "2026-11-04T21:00:00.000Z", false, false],
      ["one second before 16:00 local", "2026-11-05T12:59:59.000Z", false, false],
      ["at 16:00 local exactly", "2026-11-05T13:00:00.000Z", false, true],
      ["one second after 16:00 local", "2026-11-05T13:00:01.000Z", false, true],
      ["one second before 00:00 local", "2026-11-05T20:59:59.000Z", false, true],
      ["at 00:00 local exactly", "2026-11-05T21:00:00.000Z", true, false],
      ["one second after 00:00 local", "2026-11-05T21:00:01.000Z", true, false],
      ["days later", "2026-11-09T09:00:00.000Z", true, false],
    ])("Asia/Kuwait, %s (%s): overdue %s, due soon %s", async (_name, now, overdue, dueSoon) => {
      expect(await flagsAt(now)).toMatchObject({ overdue, dueSoon, deadlineAt: "2026-11-05T21:00:00.000Z" });
    });

    it("never flags a work that is DONE, and still gives its deadline", async () => {
      for (const now of ["2026-11-05T13:00:00.000Z", "2026-11-06T00:00:00.000Z"]) {
        expect(await flagsAt(now, "DONE")).toEqual({
          overdue: false,
          dueSoon: false,
          deadlineAt: "2026-11-05T21:00:00.000Z",
        });
      }
    });

    it("follows SMALL_WORKS_ALERT_HOURS_BEFORE: 24 hours opens the window a day earlier", async () => {
      const policy = { ...KUWAIT, hoursBefore: 24 };
      expect((await flagsAt("2026-11-04T20:59:59.000Z", "PENDING", policy)).dueSoon).toBe(false);
      expect((await flagsAt("2026-11-04T21:00:00.000Z", "PENDING", policy)).dueSoon).toBe(true);
    });

    // New York has daylight saving. On 2026-11-01 the clocks go back at 02:00 (a 25-hour day), so the end of that day is
    // 2026-11-02 00:00 EST = 05:00Z, and 8 hours before it is 21:00Z (16:00 EST).
    it.each([
      ["one second before the window", "2026-11-01T20:59:59.000Z", false, false],
      ["at the start of the window", "2026-11-01T21:00:00.000Z", false, true],
      ["one second before the deadline", "2026-11-02T04:59:59.000Z", false, true],
      ["at the deadline", "2026-11-02T05:00:00.000Z", true, false],
    ])(
      "America/New_York on the day the clocks go back, %s: overdue %s, due soon %s",
      async (_name, now, overdue, dueSoon) => {
        const policy = { timeZone: "America/New_York", hoursBefore: 8 };
        expect(await flagsAt(now, "PENDING", policy, "2026-11-01")).toMatchObject({
          overdue,
          dueSoon,
          deadlineAt: "2026-11-02T05:00:00.000Z",
        });
      },
    );

    // On 2026-03-08 the clocks go forward at 02:00 (a 23-hour day): the end of the day is 2026-03-09 00:00 EDT = 04:00Z.
    it.each([
      ["one second before the window", "2026-03-08T19:59:59.000Z", false, false],
      ["at the start of the window", "2026-03-08T20:00:00.000Z", false, true],
      ["at the deadline", "2026-03-09T04:00:00.000Z", true, false],
    ])(
      "America/New_York on the day the clocks go forward, %s: overdue %s, due soon %s",
      async (_name, now, overdue, dueSoon) => {
        const policy = { timeZone: "America/New_York", hoursBefore: 8 };
        expect(await flagsAt(now, "PENDING", policy, "2026-03-08")).toMatchObject({
          overdue,
          dueSoon,
          deadlineAt: "2026-03-09T04:00:00.000Z",
        });
      },
    );

    it("gives the list the same answer as the flags, for every instant around the boundaries", async () => {
      addSmallWork({
        villaId: villa.id,
        contractorId,
        startDate: day("2026-11-01"),
        endDate: day("2026-11-05"),
      });
      for (const now of [
        "2026-11-05T12:59:59.000Z",
        "2026-11-05T13:00:00.000Z",
        "2026-11-05T20:59:59.000Z",
        "2026-11-05T21:00:00.000Z",
      ]) {
        const service = serviceAt(now);
        const [dto] = (await service.list({ page: 1, limit: 20 })).items;
        for (const [flag, name] of [
          [true, "overdue"],
          [false, "overdue"],
          [true, "dueSoon"],
          [false, "dueSoon"],
        ] as const) {
          const { items } = await service.list({ page: 1, limit: 20, [name]: flag });
          expect(items.length === 1, `${name}=${flag} at ${now}`).toBe(dto![name] === flag);
        }
      }
    });
  });

  it("lists with the contractor, the ranges and the sort, and sorts by the contractor's name", async () => {
    const delta = addContractor({ name: "Delta Co" });
    const a = addSmallWork({
      villaId: villa.id,
      contractorId,
      startDate: day("2026-11-01"),
      endDate: day("2026-11-09"),
    });
    const b = addSmallWork({
      villaId: villa.id,
      contractorId: delta.id,
      startDate: day("2026-11-03"),
      endDate: day("2026-11-05"),
    });
    const service = serviceAt("2026-10-27T10:00:00.000Z");
    const ids = async (query: object) =>
      (await service.list({ page: 1, limit: 20, ...query })).items.map((item) => item.id);

    expect(await ids({})).toEqual([a.id, b.id]);
    expect(await ids({ sort: "endDate:asc" })).toEqual([b.id, a.id]);
    expect(await ids({ sort: "startDate:desc" })).toEqual([b.id, a.id]);
    expect(await ids({ sort: "contractorName:asc" })).toEqual([b.id, a.id]);
    expect(await ids({ contractorId: delta.id })).toEqual([b.id]);
    expect(await ids({ startFrom: day("2026-11-02") })).toEqual([b.id]);
    expect(await ids({ startTo: day("2026-11-02") })).toEqual([a.id]);
    expect(await ids({ endFrom: day("2026-11-06") })).toEqual([a.id]);
    expect(await ids({ endTo: day("2026-11-06") })).toEqual([b.id]);
    expect(await ids({ search: "delta" })).toEqual([b.id]);
  });

  it("makes the status PENDING when the input has none, and keeps one it has", async () => {
    const service = serviceAt("2026-10-27T10:00:00.000Z");

    await expect(service.create(actor(), input("2026-10-27"), ctx)).resolves.toMatchObject({
      status: "PENDING",
    });
    await expect(
      service.create(actor(), { ...input("2026-10-27"), status: "DONE" }, ctx),
    ).resolves.toMatchObject({ status: "DONE" });
  });

  it("answers 401 when the acting user is gone: nothing written", async () => {
    store.users = store.users.filter((user) => user.id !== admin.id);
    const service = serviceAt("2026-10-27T10:00:00.000Z");

    await expect(service.create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
    expect(smallWorkTables.works).toHaveLength(0);
  });

  describe("a write that fails in the database after the checks passed", () => {
    const missingRow = (): Error => Object.assign(new Error("Prisma P2025"), { code: "P2025" });
    const at = (repository: InMemorySmallWorksRepository) =>
      serviceAt("2026-10-27T10:00:00.000Z", repository);

    it("answers 404 VILLA_NOT_FOUND when the villa's foreign key fails", async () => {
      const repository = new InMemorySmallWorksRepository();
      vi.spyOn(repository, "create").mockRejectedValue(foreignKeyError(VILLA_FK));

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
      });
    });

    it("lets any other database error through unchanged", async () => {
      const repository = new InMemorySmallWorksRepository();
      const failure = new Error("connection reset");
      vi.spyOn(repository, "create").mockRejectedValue(failure);

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toBe(failure);
    });

    it("answers 404 SMALL_WORK_NOT_FOUND when the row is gone by the time of the update", async () => {
      const work = await at(new InMemorySmallWorksRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySmallWorksRepository();
      vi.spyOn(repository, "update").mockRejectedValue(missingRow());

      await expect(
        at(repository).update(actor(), work.id, { description: "Changed" }, ctx),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "SMALL_WORK_NOT_FOUND",
      });
    });

    it("answers 404 SMALL_WORK_NOT_FOUND when the row is gone by the time of the delete", async () => {
      const work = await at(new InMemorySmallWorksRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySmallWorksRepository();
      vi.spyOn(repository, "delete").mockRejectedValue(missingRow());

      await expect(at(repository).remove(actor(), work.id, ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "SMALL_WORK_NOT_FOUND",
      });
    });

    it("lets another error of the delete through unchanged", async () => {
      const work = await at(new InMemorySmallWorksRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySmallWorksRepository();
      const failure = new Error("connection reset");
      vi.spyOn(repository, "delete").mockRejectedValue(failure);

      await expect(at(repository).remove(actor(), work.id, ctx)).rejects.toBe(failure);
    });

    it("answers 404 VILLA_NOT_FOUND and writes nothing when the villa lock finds no villa", async () => {
      const repository = new InMemorySmallWorksRepository();
      vi.spyOn(repository, "lockVillaShared").mockResolvedValue(false);
      const create = vi.spyOn(repository, "create");

      await expect(at(repository).create(actor(), input("2026-10-27"), ctx)).rejects.toMatchObject({
        statusCode: 404,
        code: "VILLA_NOT_FOUND",
      });
      expect(create).not.toHaveBeenCalled();
    });

    it("answers 404 SMALL_WORK_NOT_FOUND when the row is gone between the lock and the read", async () => {
      const work = await at(new InMemorySmallWorksRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySmallWorksRepository();
      vi.spyOn(repository, "findById").mockResolvedValue(null);

      await expect(
        at(repository).update(actor(), work.id, { description: "Changed" }, ctx),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: "SMALL_WORK_NOT_FOUND",
      });
    });

    it("reports the version the row has now when a delete finds the row changed", async () => {
      const work = await at(new InMemorySmallWorksRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySmallWorksRepository();
      vi.spyOn(repository, "delete").mockImplementation(async () => {
        smallWorkTables.works[0]!.version = 7;
        return false;
      });

      await expect(at(repository).remove(actor(), work.id, ctx)).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
        details: [{ path: "version", message: "Current version", value: 7 }],
      });
      expect(smallWorkTables.works).toHaveLength(1);
    });

    it("answers the time the row was last changed, not the time it was made", async () => {
      const service = at(new InMemorySmallWorksRepository());
      const work = await service.create(actor(), input("2026-10-27"), ctx);
      smallWorkTables.works[0]!.createdAt = new Date("2026-01-01T00:00:00.000Z");
      smallWorkTables.works[0]!.updatedAt = new Date("2026-02-02T03:04:05.000Z");

      await expect(service.get(work.id, ctx)).resolves.toMatchObject({
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-02-02T03:04:05.000Z",
      });
    });

    it("does not lock a villa for a small work that does not exist", async () => {
      const repository = new InMemorySmallWorksRepository();
      const lock = vi.spyOn(repository, "lockVillaShared");

      await expect(
        at(repository).update(
          actor(),
          "00000000-0000-4000-8000-000000000000",
          { description: "Changed" },
          ctx,
        ),
      ).rejects.toMatchObject({ code: "SMALL_WORK_NOT_FOUND" });
      expect(lock).not.toHaveBeenCalled();
    });

    it("locks the villa before the row on every write to an existing small work", async () => {
      const work = await at(new InMemorySmallWorksRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySmallWorksRepository();
      const order: string[] = [];
      const lockVilla = repository.lockVillaShared.bind(repository);
      const lockRow = repository.lockVersion.bind(repository);
      vi.spyOn(repository, "lockVillaShared").mockImplementation(
        async (id) => (order.push("villa"), lockVilla(id)),
      );
      vi.spyOn(repository, "lockVersion").mockImplementation(async (id) => (order.push("row"), lockRow(id)));

      await at(repository).update(actor(), work.id, { description: "Changed" }, ctx);
      await at(repository).remove(actor(), work.id, ctx);

      expect(order).toEqual(["villa", "row", "villa", "row"]);
    });

    it("reports the version the row has now when the stored version moved after it was read", async () => {
      const work = await at(new InMemorySmallWorksRepository()).create(actor(), input("2026-10-27"), ctx);
      const repository = new InMemorySmallWorksRepository();
      // The compare-and-set finds the row changed: the answer carries the version the table has now.
      vi.spyOn(repository, "update").mockImplementation(async () => {
        smallWorkTables.works[0]!.version = 7;
        return null;
      });

      await expect(
        at(repository).update(actor(), work.id, { description: "Changed" }, ctx),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
        details: [{ path: "version", message: "Current version", value: 7 }],
      });
    });

    it("ignores keys of the input that are not fields of a small work", async () => {
      const repository = new InMemorySmallWorksRepository();
      const service = at(repository);
      const work = await service.create(actor(), input("2026-10-27"), ctx);
      const update = vi.spyOn(repository, "update");

      await service.update(
        actor(),
        work.id,
        { description: "Changed", villaId: "x", version: 9 } as unknown as { description: string },
        ctx,
      );

      expect(update.mock.calls[0]![2]).toEqual({ description: "Changed" });
    });
  });
});
