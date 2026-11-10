import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { addPhase, phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { addVilla, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { InMemoryOpenWorksRepository, addWorkItem } from "./in-memory-open-works.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import {
  OpenWorksService,
  statusAgreesWithProgress,
} from "../../../src/modules/open-works/service/open-works.service.js";
import type { OpenWorksRepository } from "../../../src/modules/open-works/repository/open-works.repository.js";
import type { ListOpenWorksQuery } from "../../../src/modules/open-works/validators/open-works.validators.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const query = (extra: Partial<ListOpenWorksQuery> = {}): ListOpenWorksQuery => ({
  page: 1,
  limit: 20,
  ...extra,
});

let villa: StoredVilla;
let actor: Actor;

beforeEach(() => {
  store.reset();
  engineerTables.reset();
  contractorTables.reset();
  villaTables.reset();
  phaseTables.reset();
  actor = {
    id: store.addUser({ name: "Admin", email: "a@x.test", passwordHash: "x", role: "ADMIN" }).id,
    role: "ADMIN",
  };
  addEngineer({ name: "Mona Hassan" });
  addContractor({ name: "Nile Builders" });
  villa = addVilla({ villaNumber: "P-001" });
});

describe("statusAgreesWithProgress", () => {
  it.each([
    ["NOT_STARTED", 0, true],
    ["NOT_STARTED", 1, false],
    ["NOT_STARTED", 100, false],
    ["IN_PROGRESS", 0, true],
    ["IN_PROGRESS", 50, true],
    ["IN_PROGRESS", 99, true],
    ["IN_PROGRESS", 100, false],
    ["DELAYED", 0, true],
    ["DELAYED", 99, true],
    ["DELAYED", 100, false],
    ["DONE", 0, false],
    ["DONE", 99, false],
    ["DONE", 100, true],
  ] as const)("%s at %i: %s", (status, progress, expected) => {
    expect(statusAgreesWithProgress(status, progress)).toBe(expected);
  });
});

// "Overdue" and "today" are the UTC day, the one the dashboard's overdue and upcoming use (shared/utils/day.ts).
describe("overdue, with an injected clock", () => {
  // APP_TIMEZONE is UTC unless a test says otherwise.
  const serviceAt = (now: string, timeZone = "UTC") =>
    new OpenWorksService(new InMemoryOpenWorksRepository(), () => new Date(now), { timeZone });
  const workAt = async (
    now: string,
    endDate: string,
    status: "IN_PROGRESS" | "DONE" = "IN_PROGRESS",
    timeZone = "UTC",
  ) => {
    const item = addWorkItem({
      villaId: villa.id,
      endDate: day(endDate),
      status,
      progress: status === "DONE" ? 100 : 10,
    });
    return serviceAt(now, timeZone).get(item.id, ctx);
  };
  const overdueOf = async (now: string, endDate: string, status: "IN_PROGRESS" | "DONE" = "IN_PROGRESS") =>
    (await workAt(now, endDate, status)).overdue;

  it("an end date today is not overdue, from the first to the last instant of the UTC day", async () => {
    expect(await overdueOf("2026-11-05T00:00:00.000Z", "2026-11-05")).toBe(false);
    expect(await overdueOf("2026-11-05T23:59:59.999Z", "2026-11-05")).toBe(false);
  });

  it("an end date yesterday is overdue from the first instant of the next UTC day", async () => {
    expect(await overdueOf("2026-11-05T23:59:59.999Z", "2026-11-04")).toBe(true);
    expect(await overdueOf("2026-11-06T00:00:00.000Z", "2026-11-05")).toBe(true);
  });

  it("uses the day of APP_TIMEZONE: Kuwait's midnight, not UTC's", async () => {
    // 21:30 UTC on the 5th is already 00:30 on the 6th in Kuwait (UTC+3): a work that ended on the 5th is late there.
    expect(
      (await workAt("2026-11-05T21:30:00.000Z", "2026-11-05", "IN_PROGRESS", "Asia/Kuwait")).overdue,
    ).toBe(true);
    // 20:59 UTC is still the 5th in Kuwait.
    expect(
      (await workAt("2026-11-05T20:59:00.000Z", "2026-11-05", "IN_PROGRESS", "Asia/Kuwait")).overdue,
    ).toBe(false);
  });

  it("counts the whole days the work is late, 0 when it is not", async () => {
    expect((await workAt("2026-11-05T12:00:00.000Z", "2026-11-02")).overdueDays).toBe(3);
    expect((await workAt("2026-11-05T12:00:00.000Z", "2026-11-04")).overdueDays).toBe(1);
    expect((await workAt("2026-11-05T12:00:00.000Z", "2026-11-05")).overdueDays).toBe(0);
    expect((await workAt("2026-11-05T12:00:00.000Z", "2026-11-01", "DONE")).overdueDays).toBe(0);
  });

  it("a done item is never overdue, and an item with no end date neither", async () => {
    expect(await overdueOf("2030-01-01T00:00:00.000Z", "2026-11-05", "DONE")).toBe(false);
    const item = addWorkItem({ villaId: villa.id });
    expect((await serviceAt("2030-01-01T00:00:00.000Z").get(item.id, ctx)).overdue).toBe(false);
  });

  it("filters the list by the same day", async () => {
    const yesterday = addPhase({ name: "yesterday" });
    const today = addPhase({ name: "today" });
    addWorkItem({
      villaId: villa.id,
      elecPhaseId: yesterday.id,
      endDate: day("2026-11-04"),
      progress: 5,
      status: "IN_PROGRESS",
    });
    addWorkItem({
      villaId: villa.id,
      elecPhaseId: today.id,
      endDate: day("2026-11-05"),
      progress: 5,
      status: "IN_PROGRESS",
    });
    const service = serviceAt("2026-11-05T12:00:00.000Z");

    const late = await service.list(query({ overdue: true }));
    const onTime = await service.list(query({ overdue: false }));

    expect(late.items.map((i) => i.elecPhase.name)).toEqual(["yesterday"]);
    expect(onTime.items.map((i) => i.elecPhase.name)).toEqual(["today"]);
  });

  it("hands the repository the day of APP_TIMEZONE as today", async () => {
    const repository = new InMemoryOpenWorksRepository();
    const spy = vi.spyOn(repository, "list");

    await new OpenWorksService(repository, () => new Date("2026-11-05T22:30:00.000Z"), {
      timeZone: "UTC",
    }).list(query());
    expect(spy.mock.calls[0]?.[0].today).toEqual(day("2026-11-05"));

    await new OpenWorksService(repository, () => new Date("2026-11-05T22:30:00.000Z"), {
      timeZone: "Asia/Kuwait",
    }).list(query());
    expect(spy.mock.calls[1]?.[0].today).toEqual(day("2026-11-06"));
  });
});

describe("a write", () => {
  it("goes through one transaction: the create and the audit entry are written in it", async () => {
    const repository = new InMemoryOpenWorksRepository();
    const transaction = vi.spyOn(repository, "transaction");
    const create = vi.spyOn(repository, "create");

    await new OpenWorksService(repository as unknown as OpenWorksRepository).create(
      actor,
      { villaId: villa.id, elecPhaseId: addPhase({ name: "Finishing" }).id },
      ctx,
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.auditRows).toHaveLength(1);
  });
});
