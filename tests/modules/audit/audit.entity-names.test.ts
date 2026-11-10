import { describe, expect, it, vi } from "vitest";
import {
  AuditRepository,
  type Db,
  type EntityNameRow,
} from "../../../src/modules/audit/repository/audit.repository.js";

// The five entities of the work records (an open work, a daily report, a daily small work, a site report, a daily labour entry)
// are named like the older ones: from the record while it exists, from the entry's own snapshot once it is gone.
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

function stub(tables: {
  workItem?: Record<string, { elecPhase: { name: string }; villa: { villaNumber: string } }>;
  siteReport?: Record<string, { title: string }>;
  dailySmallWork?: Record<string, { description: string }>;
  dailyReport?: Record<string, { reportDate: Date }>;
  dailyLabour?: Record<string, { labourDate: Date }>;
  auditLog?: Record<string, { before?: unknown; after?: unknown }>;
}) {
  const reading = (table: Record<string, object> = {}) =>
    vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id in table).map((id) => ({ id, ...table[id] })),
    );
  const raw = {
    workItem: { findMany: reading(tables.workItem) },
    siteReport: { findMany: reading(tables.siteReport) },
    dailySmallWork: { findMany: reading(tables.dailySmallWork) },
    dailyReport: { findMany: reading(tables.dailyReport) },
    dailyLabour: { findMany: reading(tables.dailyLabour) },
    auditLog: { findMany: reading(tables.auditLog) },
  };
  return { db: raw as unknown as Db, raw };
}

const entry = (id: string, entity: string, entityId: string | null, extra: Partial<EntityNameRow> = {}) => ({
  id,
  entity,
  entityId,
  ...extra,
});

const repository = new AuditRepository();

describe("the names of the work records", () => {
  it("an open work is named by its phase and villa; a site report and a small work by their title or description", async () => {
    const { db } = stub({
      workItem: { w1: { elecPhase: { name: "First fix" }, villa: { villaNumber: "P-007" } } },
      siteReport: { s1: { title: "Weekly safety walk" } },
      dailySmallWork: { d1: { description: "Replace two sockets" } },
    });

    const names = await repository.entityNames(
      [entry("1", "WorkItem", "w1"), entry("2", "SiteReport", "s1"), entry("3", "DailySmallWork", "d1")],
      db,
    );

    expect(Object.fromEntries(names)).toEqual({
      "1": "First fix - P-007",
      "2": "Weekly safety walk",
      "3": "Replace two sockets",
    });
  });

  it("a daily report and a labour entry are named by their day, as YYYY-MM-DD", async () => {
    const { db } = stub({
      dailyReport: { r1: { reportDate: day("2026-10-12") } },
      dailyLabour: { l1: { labourDate: day("2026-01-05") } },
    });

    const names = await repository.entityNames(
      [entry("1", "DailyReport", "r1"), entry("2", "DailyLabour", "l1")],
      db,
    );

    expect(Object.fromEntries(names)).toEqual({ "1": "2026-10-12", "2": "2026-01-05" });
  });

  it("reads the record's own selection: only the id and the one field that names it", async () => {
    const { db, raw } = stub({
      workItem: { w1: { elecPhase: { name: "x" }, villa: { villaNumber: "y" } } },
    });

    await repository.entityNames([entry("1", "WorkItem", "w1")], db);

    expect(raw.workItem.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["w1"] } },
      select: { id: true, elecPhase: { select: { name: true } }, villa: { select: { villaNumber: true } } },
    });
  });

  it.each([
    ["WorkItem", "name", { name: "First fix - P-007" }],
    ["SiteReport", "title", { title: "Gone visit" }],
    ["DailySmallWork", "description", { description: "Gone small work" }],
    ["DailyReport", "reportDate", { reportDate: "2026-09-30" }],
    ["DailyLabour", "labourDate", { labourDate: "2026-09-29" }],
  ])("a deleted %s is named from the entry's own snapshot (%s)", async (kind, _field, snapshot) => {
    const { db } = stub({ auditLog: { a1: { before: snapshot, after: null } } });

    const names = await repository.entityNames([entry("a1", kind, "gone-id")], db);

    expect(names.get("a1")).toBe(Object.values(snapshot)[0]);
  });

  it("uses the snapshot the caller already holds, and does not fetch it again", async () => {
    const { db, raw } = stub({});

    const names = await repository.entityNames(
      [entry("a1", "WorkItem", "gone", { before: { name: "Held" }, after: null })],
      db,
    );

    expect(names.get("a1")).toBe("Held");
    expect(raw.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("runs one query per kind, however many entries there are", async () => {
    const works = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `w${i}`,
        { elecPhase: { name: `Phase ${i}` }, villa: { villaNumber: `P-${i}` } },
      ]),
    );
    const { db, raw } = stub({ workItem: works });

    const names = await repository.entityNames(
      Array.from({ length: 200 }, (_, i) => entry(`e${i}`, "WorkItem", `w${i}`)),
      db,
    );

    expect(names.size).toBe(200);
    expect(raw.workItem.findMany).toHaveBeenCalledTimes(1);
    expect(raw.siteReport.findMany).not.toHaveBeenCalled();
  });

  it("an entry with no id is left unnamed, and no query is made for it", async () => {
    const { db, raw } = stub({});

    const names = await repository.entityNames([entry("1", "DailyReport", null)], db);

    expect(names.size).toBe(0);
    expect(raw.dailyReport.findMany).not.toHaveBeenCalled();
  });
});
