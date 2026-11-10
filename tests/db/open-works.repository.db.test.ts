import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The open works' SQL (the list with its filters, sorts and paging; the automatic items' insert, locks and updates) on a
// real PostgreSQL, in a scratch schema that is dropped at the end. Off unless ASICO_DB_TESTS=1.
//   ASICO_DB_TESTS=1 npx vitest run tests/db
const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import type { OpenWorkFilters, OpenWorkSort } from "../../src/modules/open-works/dto/open-works.dto.js";
import { ElecPhasesRepository } from "../../src/modules/elec-phases/repository/elec-phases.repository.js";
import { OpenWorksRepository } from "../../src/modules/open-works/repository/open-works.repository.js";
import {
  countItemsOfPhase,
  countManualItemsOfVilla,
} from "../../src/modules/open-works/repository/work-item-rows.js";

const TODAY = new Date("2026-11-05T00:00:00.000Z");
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

type Fixture = {
  id: string;
  villa: string;
  // The electrical phase the item is filed under (its name is what the list sorts and searches by).
  phase: string;
  status: string;
  priority: string;
  progress: number;
  start: string | null;
  end: string | null;
  source: "MANUAL" | "PHASE";
  contractor: string | null;
};

// The phases of the fixture: the sort order of a phase decides the order of the items of one place.
const PHASES: [string, string, number][] = [
  ["ph1", "Wall piping X", 901],
  ["ph2", "Cabling X", 902],
  ["pA", "Cable tray", 910],
  ["pB", "Paint walls", 911],
  ["pC", "A9 snag", 912],
  ["pD", "A10 snag", 913],
  ["pE", "100% done_ work\\ok", 914],
  ["pF", "50x done", 915],
];

// Ids sort the way they read, so a tie-break by id is easy to predict.
const ITEMS: Fixture[] = [
  {
    id: "i1",
    villa: "vA",
    phase: "pA",
    status: "DELAYED",
    priority: "HIGH",
    progress: 30,
    start: "2026-10-01",
    end: "2026-10-20",
    source: "MANUAL",
    contractor: "con1",
  },
  {
    id: "i2",
    villa: "vB",
    phase: "pB",
    status: "NOT_STARTED",
    priority: "LOW",
    progress: 0,
    start: null,
    end: "2026-12-01",
    source: "MANUAL",
    contractor: null,
  },
  {
    id: "i3",
    villa: "vC",
    phase: "pC",
    status: "IN_PROGRESS",
    priority: "MEDIUM",
    progress: 50,
    start: "2026-11-01",
    end: null,
    source: "MANUAL",
    contractor: "con2",
  },
  {
    id: "i4",
    villa: "vC",
    phase: "pD",
    status: "DONE",
    priority: "HIGH",
    progress: 100,
    start: "2026-09-01",
    end: "2026-09-30",
    source: "MANUAL",
    contractor: null,
  },
  {
    id: "i5",
    villa: "vA",
    phase: "ph1",
    status: "IN_PROGRESS",
    priority: "MEDIUM",
    progress: 40,
    start: "2026-10-20",
    end: null,
    source: "PHASE",
    contractor: "con1",
  },
  {
    id: "i6",
    villa: "vD",
    phase: "pE",
    status: "IN_PROGRESS",
    priority: "LOW",
    progress: 10,
    start: "2026-11-02",
    end: "2026-11-05",
    source: "MANUAL",
    contractor: "con1",
  },
  {
    id: "i7",
    villa: "vD",
    phase: "pF",
    status: "NOT_STARTED",
    priority: "LOW",
    progress: 0,
    start: null,
    end: "2026-11-04",
    source: "MANUAL",
    contractor: null,
  },
];

describe.skipIf(!RUN)("the open works' SQL on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const repository = new OpenWorksRepository();
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  beforeAll(async () => {
    scratch = await openScratch("scratch9r", 5);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","updatedAt") VALUES ('admin','Root Admin','a@x.test','x','ADMIN',now())`,
    );
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","updatedAt") VALUES ('con1','Nile','010',now()), ('con2','Giza','011',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(
      `INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('a1','New Cairo','Cairo',now()), ('a2','Zayed','Giza',now())`,
    );
    for (const [id, name, sortOrder] of PHASES) {
      await q(`INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ($1,$2,$3,now())`, [
        id,
        name,
        sortOrder,
      ]);
    }
    await q(`INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt") VALUES
      ('vA','V-A','A2','5','eng','admin','a1','con1',now()),
      ('vB','V-B','A10','1','eng','admin','a1',NULL,now()),
      ('vC','V-C','A2','10','eng','admin','a1','con2',now()),
      ('vD','V-D','B1','1','eng','admin','a2','con1',now())`);
    for (const item of ITEMS) {
      await q(
        `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","status","priority","progress","contractorId","startDate","endDate","source","createdById","updatedAt")
         VALUES ($1,$2,$3,$4::"WorkStatus",$5::"Priority",$6,$7,$8,$9,$10::"WorkItemSource",'admin',now())`,
        [
          item.id,
          item.villa,
          item.phase,
          item.status,
          item.priority,
          item.progress,
          item.contractor,
          item.start,
          item.end,
          item.source,
        ],
      );
    }
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  }, 60_000);

  const list = async (
    filters: OpenWorkFilters = {},
    sort: OpenWorkSort = { field: "location", direction: "asc" },
    skip = 0,
    take = 100,
  ) => repository.list({ filters, sort, today: TODAY, skip, take });
  const ids = async (filters: OpenWorkFilters = {}, sort?: OpenWorkSort): Promise<string[]> =>
    (await list(filters, sort)).rows.map((row) => row.id);
  const sorted = (field: OpenWorkSort["field"], direction: "asc" | "desc" = "asc") => ({ field, direction });

  describe("the list", () => {
    it("lists everything with the total, and the joined villa, phase, contractor and creator", async () => {
      const { rows, total } = await list();

      expect(total).toBe(7);
      expect(rows).toHaveLength(7);
      const wall = rows.find((row) => row.id === "i5")!;
      expect(wall).toMatchObject({
        source: "PHASE",
        elecPhase: { id: "ph1", name: "Wall piping X" },
        contractor: { id: "con1", name: "Nile" },
        createdBy: { id: "admin", name: "Root Admin" },
        villa: { id: "vA", villaNumber: "V-A", block: "A2", plot: "5", area: { name: "New Cairo" } },
      });
      expect(rows.find((row) => row.id === "i2")!.contractor).toBeNull();
    });

    describe("sorted by location (area, block, plot in natural order, then the phase's own order)", () => {
      it("ascending: A2 before A10, plot 5 before 10, the earlier phase first inside one place", async () => {
        expect(await ids()).toEqual(["i5", "i1", "i3", "i4", "i2", "i6", "i7"]);
      });

      it("descending reverses the places but not the phases inside one place", async () => {
        expect(await ids({}, sorted("location", "desc"))).toEqual(["i6", "i7", "i2", "i3", "i4", "i5", "i1"]);
      });
    });

    it("sorts the phase names in natural order, either way, with the id as the tie-break", async () => {
      const ascending = await ids({}, sorted("elecPhaseName"));
      expect(ascending.indexOf("i3")).toBeLessThan(ascending.indexOf("i4"));
      expect(ascending.indexOf("i7")).toBeLessThan(ascending.indexOf("i6"));
      expect(await ids({}, sorted("elecPhaseName", "desc"))).toEqual([...ascending].reverse());
    });

    it("sorts the status and the priority in the order of their enums", async () => {
      const byStatus = (await list({}, sorted("status"))).rows.map((row) => row.status);
      expect(byStatus).toEqual([
        "NOT_STARTED",
        "NOT_STARTED",
        "IN_PROGRESS",
        "IN_PROGRESS",
        "IN_PROGRESS",
        "DELAYED",
        "DONE",
      ]);
      expect((await list({}, sorted("status", "desc"))).rows.map((row) => row.status)[0]).toBe("DONE");
      const byPriority = (await list({}, sorted("priority"))).rows.map((row) => row.priority);
      expect(byPriority).toEqual(["LOW", "LOW", "LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH"]);
    });

    it("breaks a tie by the id, ascending, whichever the direction", async () => {
      expect(await ids({}, sorted("priority"))).toEqual(["i2", "i6", "i7", "i3", "i5", "i1", "i4"]);
      expect(await ids({}, sorted("priority", "desc"))).toEqual(["i1", "i4", "i3", "i5", "i2", "i6", "i7"]);
    });

    it("sorts the progress", async () => {
      expect(await ids({}, sorted("progress"))).toEqual(["i2", "i7", "i6", "i1", "i5", "i3", "i4"]);
      expect(await ids({}, sorted("progress", "desc"))).toEqual(["i4", "i3", "i5", "i1", "i6", "i2", "i7"]);
    });

    it("puts the items without a date last, ascending or descending", async () => {
      expect(await ids({}, sorted("startDate"))).toEqual(["i4", "i1", "i5", "i3", "i6", "i2", "i7"]);
      expect(await ids({}, sorted("startDate", "desc"))).toEqual(["i6", "i3", "i5", "i1", "i4", "i2", "i7"]);
      expect(await ids({}, sorted("endDate"))).toEqual(["i4", "i1", "i7", "i6", "i2", "i3", "i5"]);
      expect(await ids({}, sorted("endDate", "desc"))).toEqual(["i2", "i6", "i7", "i1", "i4", "i3", "i5"]);
    });

    describe("filters", () => {
      it.each<[string, OpenWorkFilters, string[]]>([
        ["villaId", { villaId: "vC" }, ["i3", "i4"]],
        ["elecPhaseId", { elecPhaseId: "ph1" }, ["i5"]],
        ["status", { status: "DELAYED" }, ["i1"]],
        ["priority", { priority: "HIGH" }, ["i1", "i4"]],
        ["contractorId", { contractorId: "con1" }, ["i5", "i1", "i6"]],
        ["startFrom (inclusive)", { startFrom: day("2026-11-01") }, ["i3", "i6"]],
        ["startTo (inclusive)", { startTo: day("2026-10-01") }, ["i1", "i4"]],
        ["a start range", { startFrom: day("2026-10-01"), startTo: day("2026-10-20") }, ["i5", "i1"]],
        ["endFrom (inclusive)", { endFrom: day("2026-11-05") }, ["i2", "i6"]],
        ["endTo (inclusive)", { endTo: day("2026-09-30") }, ["i4"]],
        ["several at once", { villaId: "vA", status: "DELAYED" }, ["i1"]],
      ])("by %s", async (_name, filters, expected) => {
        const { rows, total } = await list(filters);

        expect(rows.map((row) => row.id)).toEqual(expected);
        expect(total).toBe(expected.length);
      });

      it("by overdue=true: the end date is before today and the work is not done", async () => {
        // i1 ended 2026-10-20 and is delayed; i7 ended yesterday; i4 ended long ago but is done; i6 ends today.
        expect(await ids({ overdue: true })).toEqual(["i1", "i7"]);
      });

      it("by overdue=false: everything else, including the items with no end date", async () => {
        expect(await ids({ overdue: false })).toEqual(["i5", "i3", "i4", "i2", "i6"]);
      });

      it("moves the boundary with today", async () => {
        const next = await repository.list({
          filters: { overdue: true },
          sort: sorted("location"),
          today: day("2026-11-06"),
          skip: 0,
          take: 100,
        });

        expect(next.rows.map((row) => row.id)).toEqual(["i1", "i6", "i7"]);
      });
    });

    describe("the search on the villa number, the phase name and the contractor name", () => {
      it("ignores case and matches inside the phase name", async () => {
        expect(await ids({ search: "WALL" })).toEqual(["i5", "i2"]);
      });

      it("matches the villa number and the contractor name too", async () => {
        expect(await ids({ search: "v-c" })).toEqual(["i3", "i4"]);
        expect(await ids({ search: "giza" })).toEqual(["i3"]);
        expect(await ids({ search: "nile" })).toEqual(["i5", "i1", "i6"]);
      });

      it("takes % literally: it matches the phase name that has one, not everything", async () => {
        expect(await ids({ search: "%" })).toEqual(["i6"]);
        expect(await ids({ search: "100%" })).toEqual(["i6"]);
      });

      it("takes _ literally: it does not stand for any character", async () => {
        expect(await ids({ search: "_" })).toEqual(["i6"]);
        expect(await ids({ search: "done_" })).toEqual(["i6"]);
        expect(await ids({ search: "done?" })).toEqual([]);
      });

      it("takes a backslash literally", async () => {
        expect(await ids({ search: "\\" })).toEqual(["i6"]);
        expect(await ids({ search: "work\\ok" })).toEqual(["i6"]);
      });

      it("finds nothing for a word that is in none of them", async () => {
        const { rows, total } = await list({ search: "zzz" });
        expect(rows).toEqual([]);
        expect(total).toBe(0);
      });
    });

    describe("paging", () => {
      it("returns the page asked for, with the total of the whole filter", async () => {
        const second = await list({}, sorted("progress"), 3, 2);

        expect(second.rows.map((row) => row.id)).toEqual(["i1", "i5"]);
        expect(second.total).toBe(7);
      });

      it("returns no rows past the end, with the true total", async () => {
        const past = await list({}, sorted("progress"), 70, 10);

        expect(past.rows).toEqual([]);
        expect(past.total).toBe(7);
      });

      it("pages through everything without repeating or skipping a row", async () => {
        const seen: string[] = [];
        for (let skip = 0; skip < 7; skip += 2) {
          seen.push(...(await list({}, sorted("priority"), skip, 2)).rows.map((row) => row.id));
        }

        expect(seen).toEqual(["i2", "i6", "i7", "i3", "i5", "i1", "i4"]);
      });
    });
  });

  describe("one item", () => {
    it("reads it by id, with its relations, and null for an unknown id", async () => {
      const row = await repository.findById("i1");

      expect(row).toMatchObject({
        id: "i1",
        contractor: { name: "Nile" },
        elecPhase: { id: "pA", name: "Cable tray" },
      });
      expect(await repository.findById("nope")).toBeNull();
    });

    it("tells the villa of an item, and null for an unknown item", async () => {
      expect(await scratch.prisma.$transaction((tx) => repository.findVillaId("i3", tx))).toBe("vC");
      expect(await scratch.prisma.$transaction((tx) => repository.findVillaId("nope", tx))).toBeNull();
    });

    it("locks the villa shared and returns its contractor, or null for an unknown villa", async () => {
      const result = await scratch.prisma.$transaction(async (tx) => [
        await repository.lockVillaShared("vA", tx),
        await repository.lockVillaShared("vB", tx),
        await repository.lockVillaShared("nope", tx),
      ]);

      expect(result).toEqual([{ contractorId: "con1" }, { contractorId: null }, null]);
    });

    it("locks an item and returns its version, or null", async () => {
      const result = await scratch.prisma.$transaction(async (tx) => [
        await repository.lockVersion("i1", tx),
        await repository.lockVersion("nope", tx),
      ]);

      expect(result).toEqual([1, null]);
    });
  });

  describe("writing by hand", () => {
    it("creates a MANUAL item at version 1 with its relations", async () => {
      const row = await repository.create({
        villaId: "vB",
        elecPhaseId: "ph2",
        status: "IN_PROGRESS",
        priority: "HIGH",
        progress: 20,
        contractorId: null,
        startDate: day("2026-11-01"),
        endDate: day("2026-11-30"),
        createdById: "admin",
      });

      expect(row).toMatchObject({
        source: "MANUAL",
        version: 1,
        elecPhase: { id: "ph2" },
        createdBy: { id: "admin" },
        villa: { id: "vB" },
      });
      await q(`DELETE FROM "WorkItem" WHERE "id" = $1`, [row.id]);
    });

    it("changes an item only at the version it was read at, and bumps it", async () => {
      const done = await repository.update("i2", 1, {
        elecPhaseId: "ph2",
        progress: 5,
        status: "IN_PROGRESS",
      });
      const stale = await repository.update("i2", 1, { progress: 9 });

      expect(done).toMatchObject({
        elecPhase: { id: "ph2" },
        progress: 5,
        status: "IN_PROGRESS",
        version: 2,
      });
      expect(stale).toBeNull();
      expect((await repository.findById("i2"))!.progress).toBe(5);
      await q(
        `UPDATE "WorkItem" SET "elecPhaseId" = 'pB', "progress" = 0, "status" = 'NOT_STARTED', "version" = 1 WHERE "id" = 'i2'`,
      );
    });

    it("clears a nullable column with null", async () => {
      const row = await repository.update("i1", 1, { contractorId: null, endDate: null });

      expect(row).toMatchObject({ contractorId: null, endDate: null });
      await q(
        `UPDATE "WorkItem" SET "contractorId" = 'con1', "endDate" = '2026-10-20', "version" = 1 WHERE "id" = 'i1'`,
      );
    });

    it("deletes an item only at its version", async () => {
      await q(
        `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","source","createdById","updatedAt") VALUES ('gone','vB','ph1','MANUAL','admin',now())`,
      );

      expect(await repository.delete("gone", 7)).toBe(false);
      expect(await repository.delete("gone", 1)).toBe(true);
      expect(await repository.delete("gone", 1)).toBe(false);
    });

    it("reads the status of a contractor and of a phase, and null for one that is not there", async () => {
      expect(await repository.contractorStatus("con1")).toBe("ACTIVE");
      expect(await repository.contractorStatus("nope")).toBeNull();
      expect(await repository.elecPhaseStatus("ph1")).toBe("ACTIVE");
      expect(await repository.elecPhaseStatus("nope")).toBeNull();
    });
  });

  describe("one open work per villa and electrical phase", () => {
    it("finds the villa's open work under a phase, leaving out the one asked to", async () => {
      const row = (await q(`SELECT "id", "villaId", "elecPhaseId" FROM "WorkItem" WHERE "id" = 'i3'`))
        .rows[0] as {
        id: string;
        villaId: string;
        elecPhaseId: string;
      };
      const others = (
        await q(
          `SELECT count(*)::int AS "n" FROM "WorkItem" WHERE "villaId" = $1 AND "elecPhaseId" = $2 AND "id" <> $3`,
          [row.villaId, row.elecPhaseId, row.id],
        )
      ).rows[0].n as number;

      expect(
        await repository.findItemForPhase(row.villaId, row.elecPhaseId, undefined, scratch.prisma),
      ).not.toBeNull();
      const leftOut = await repository.findItemForPhase(row.villaId, row.elecPhaseId, row.id, scratch.prisma);
      expect(leftOut === null).toBe(others === 0);
      expect(
        await repository.findItemForPhase("nope", row.elecPhaseId, undefined, scratch.prisma),
      ).toBeNull();
    });

    it("lists the villa and phase pairs that already have an open work", async () => {
      const expected = (
        await q(
          `SELECT DISTINCT "villaId" || ':' || "elecPhaseId" AS "key" FROM "WorkItem" WHERE "villaId" IN ('vA', 'vC')`,
        )
      ).rows.map((r: { key: string }) => r.key);

      expect([...(await repository.takenVillaPhases(["vA", "vC"], scratch.prisma))].sort()).toEqual(
        expected.sort(),
      );
      expect(await repository.takenVillaPhases([], scratch.prisma)).toEqual(new Set());
    });

    it("makes a second writer of the same villa and phase wait for the first one's transaction", async () => {
      const order: string[] = [];
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const first = scratch.prisma.$transaction(async (tx) => {
        await repository.lockVillaPhase("vA", "ph1", tx);
        order.push("first locked");
        await held;
        order.push("first done");
      });
      // Give the first transaction time to take the lock.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const second = scratch.prisma.$transaction(async (tx) => {
        await repository.lockVillaPhase("vA", "ph1", tx);
        order.push("second locked");
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      await Promise.all([first, second]);

      expect(order).toEqual(["first locked", "first done", "second locked"]);
    });
  });

  describe("what the villas and the elec phases count", () => {
    it("counts the MANUAL items of a villa and not the automatic ones", async () => {
      expect(await countManualItemsOfVilla("vA", scratch.prisma)).toBe(1);
      expect(await countManualItemsOfVilla("vC", scratch.prisma)).toBe(2);
      expect(await countManualItemsOfVilla("nope", scratch.prisma)).toBe(0);
    });

    it("counts the items of a phase, of either source", async () => {
      expect(await countItemsOfPhase("ph1", scratch.prisma)).toBe(1);
      expect(await countItemsOfPhase("nope", scratch.prisma)).toBe(0);
    });

    it("makes a phase with an item 'in use' for the phase delete", async () => {
      const usage = await scratch.prisma.$transaction((tx) =>
        new ElecPhasesRepository().countUsage("ph1", tx),
      );

      expect(usage).toBeGreaterThanOrEqual(1);
    });
  });
});
