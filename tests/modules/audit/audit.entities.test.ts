import { describe, expect, it, vi } from "vitest";
import { t } from "../../../src/core/i18n/index.js";
import { toDetailDto, toListItemDto } from "../../../src/modules/audit/mapper/audit.mapper.js";
import {
  ENTITY_LABEL_KEYS,
  NAME_FIELD,
  canonicalEntity,
  entityCodes,
  entityLabel,
  isAuditEntity,
  nameFromSnapshots,
} from "../../../src/modules/audit/dto/entities.js";
import {
  AuditRepository,
  type AuditLogDetailRow,
  type AuditLogListRow,
  type Db,
  type EntityNameRow,
} from "../../../src/modules/audit/repository/audit.repository.js";

const CODES = [
  "User",
  "Villa",
  "Contractor",
  "CivilEngineer",
  "ElectricalEngineer",
  "ElecPhase",
  "Area",
  "VillaDocument",
  "WorkItem",
  "DailyReport",
  "DailySmallWork",
  "SiteReport",
  "DailyLabour",
  "MaintenanceVilla",
  "Factory",
  "MaterialDelivery",
  "MaterialItem",
  "AuditLog",
] as const;

describe("entity labels", () => {
  it.each([
    ["User", "User", "مستخدم"],
    ["Villa", "Villa", "فيلا"],
    ["Contractor", "Contractor", "مقاول"],
    ["CivilEngineer", "Civil engineer", "مهندس مدني"],
    ["ElectricalEngineer", "Electrical engineer", "مهندس كهرباء"],
    ["ElecPhase", "Elec phase", "مرحلة كهرباء"],
    ["Area", "Area", "منطقة"],
    ["VillaDocument", "Villa document", "مستند الفيلا"],
    ["WorkItem", "Open work", "عمل مفتوح"],
    ["DailyReport", "Daily report", "تقرير يومي"],
    ["DailySmallWork", "Daily small work", "عمل صغير يومي"],
    ["SiteReport", "Site report", "تقرير موقع"],
    ["DailyLabour", "Daily labour", "عمالة يومية"],
    ["MaintenanceVilla", "Maintenance villa", "فيلا صيانة"],
    ["Factory", "Factory", "مصنع"],
    ["MaterialDelivery", "Material delivery", "توريد مواد"],
    ["MaterialItem", "Catalog material", "مادة في القائمة"],
    ["AuditLog", "Audit log", "سجل التدقيق"],
  ])("%s is %j in English and %j in Arabic", (code, english, arabic) => {
    expect(entityLabel(code, "en")).toBe(english);
    expect(entityLabel(code, "ar")).toBe(arabic);
  });

  it("knows exactly the entities the application writes audit entries about", () => {
    expect(Object.keys(ENTITY_LABEL_KEYS).sort()).toEqual([...CODES].sort());
  });

  it("every entity has a label in both languages, and the two differ", () => {
    for (const code of CODES) {
      const key = ENTITY_LABEL_KEYS[code];
      expect(t("en", key), code).not.toBe("");
      expect(t("ar", key), code).not.toBe("");
      expect(t("ar", key), code).not.toBe(t("en", key));
    }
  });

  it.each(["Widget", "", "user", "VILLA", "constructor", "toString", "__proto__", "hasOwnProperty"])(
    "an entity it does not know (%j) keeps its code as its label, in both languages",
    (code) => {
      expect(entityLabel(code, "en")).toBe(code);
      expect(entityLabel(code, "ar")).toBe(code);
      expect(isAuditEntity(code)).toBe(false);
    },
  );

  it("is case sensitive, like the stored codes", () => {
    expect(isAuditEntity("User")).toBe(true);
    expect(isAuditEntity("user")).toBe(false);
  });
});

describe("the name field of each entity", () => {
  it("is the villa number for a villa, the name for people, the file name for a file", () => {
    expect(NAME_FIELD).toEqual({
      User: "name",
      Villa: "villaNumber",
      Contractor: "name",
      CivilEngineer: "name",
      ElectricalEngineer: "name",
      ElecPhase: "name",
      Area: "name",
      VillaDocument: "originalName",
      WorkItem: "name",
      DailyReport: "reportDate",
      DailySmallWork: "description",
      SiteReport: "title",
      DailyLabour: "labourDate",
      MaintenanceVilla: "villaNumber",
      Factory: "name",
      MaterialDelivery: "noteNumber",
      MaterialItem: "name",
      AuditLog: undefined,
    });
  });
});

describe("nameFromSnapshots", () => {
  it.each([
    ["Villa", [{ villaNumber: "P-001" }], "P-001"],
    ["Contractor", [{ name: "Nile Builders", phone: "x" }], "Nile Builders"],
    ["CivilEngineer", [{ name: "منى حسن" }], "منى حسن"],
    ["ElectricalEngineer", [{ name: "عمر خالد" }], "عمر خالد"],
    ["ElecPhase", [{ name: "Wall Piping", status: "ACTIVE", sortOrder: 5 }], "Wall Piping"],
    ["Area", [{ name: "New Cairo", city: "Cairo" }], "New Cairo"],
    ["User", [{ name: "Sara", email: "s@example.test" }], "Sara"],
    ["VillaDocument", [{ originalName: "plan.pdf" }], "plan.pdf"],
    ["WorkItem", [{ title: "Wall piping", status: "DONE" }], "Wall piping"],
    ["DailyReport", [{ reportDate: "2026-03-04", weather: "SUNNY" }], "2026-03-04"],
    ["DailySmallWork", [{ description: "Fix a socket", qty: 2 }], "Fix a socket"],
    ["SiteReport", [{ title: "First fix check", rating: 4 }], "First fix check"],
    ["DailyLabour", [{ labourDate: "2026-03-04", labourCount: 12 }], "2026-03-04"],
  ])("%s: reads the right field", (entity, snapshots, expected) => {
    expect(nameFromSnapshots(entity, ...snapshots)).toBe(expected);
  });

  it("takes the first snapshot that has a name", () => {
    expect(
      nameFromSnapshots("Villa", null, { status: "OPEN" }, { villaNumber: "P-9" }, { villaNumber: "P-1" }),
    ).toBe("P-9");
  });

  it.each([
    ["Villa", [null]],
    ["Villa", [undefined, {}]],
    ["Villa", [{ status: "OPEN" }]],
    ["Villa", [{ villaNumber: "" }]],
    ["Villa", [{ villaNumber: "   " }]],
    ["Villa", [{ villaNumber: 7 }]],
    ["Villa", [{ villaNumber: { nested: "x" } }]],
    ["Villa", ["P-001"]],
    ["Villa", [["P-001"]]],
    ["User", [{ villaNumber: "P-001" }]],
    ["AuditLog", [{ name: "x" }]],
    ["Widget", [{ name: "x" }]],
    ["Contractor", []],
  ])("%s with %j has no name", (entity, snapshots) => {
    expect(nameFromSnapshots(entity, ...snapshots)).toBeNull();
  });
});

describe("the mapper", () => {
  const row = (overrides: Partial<AuditLogListRow> = {}): AuditLogListRow => ({
    id: "log-1",
    action: "villa.create",
    entity: "Villa",
    entityId: "p1",
    ip: null,
    userAgent: null,
    requestId: null,
    createdAt: new Date("2026-03-04T05:06:07.890Z"),
    actor: null,
    ...overrides,
  });

  it("labels the entity in the language, keeps the code, and adds the name", () => {
    expect(toListItemDto(row(), { locale: "ar", entityName: "P-001" })).toMatchObject({
      entity: "فيلا",
      entityCode: "Villa",
      entityName: "P-001",
    });
    expect(toListItemDto(row(), { locale: "en", entityName: "P-001" })).toMatchObject({
      entity: "Villa",
      entityCode: "Villa",
      entityName: "P-001",
    });
  });

  it("without a view it is English, by code, with no name: that is how the export reads it", () => {
    expect(toListItemDto(row({ entity: "CivilEngineer" }))).toMatchObject({
      entity: "Civil engineer",
      entityCode: "CivilEngineer",
      entityName: null,
    });
    expect(toListItemDto(row({ entity: "CivilEngineer" }))).toHaveProperty("entityDetail", null);
  });

  it("carries the detail of the view through, and has none without one", () => {
    expect(
      toListItemDto(row({ entity: "User" }), { entityName: "Mona", entityDetail: "mona@x.test" }),
    ).toMatchObject({
      entityName: "Mona",
      entityDetail: "mona@x.test",
    });
    expect(toListItemDto(row({ entity: "User" }), { entityName: "Mona" })).toHaveProperty(
      "entityDetail",
      null,
    );
    expect(
      toDetailDto({ ...row({ entity: "User" }), before: null, after: null }, { entityDetail: "m@x.test" }),
    ).toHaveProperty("entityDetail", "m@x.test");
  });

  it("the entity name is null, not missing, when none was found", () => {
    const item = toListItemDto(row(), { locale: "en" });

    expect(item).toHaveProperty("entityName", null);
  });

  it("an unknown entity keeps its code in `entity`", () => {
    expect(toListItemDto(row({ entity: "Widget" }), { locale: "ar" })).toMatchObject({
      entity: "Widget",
      entityCode: "Widget",
    });
  });

  it("the detail has the same fields plus before and after", () => {
    const detail: AuditLogDetailRow = { ...row(), before: null, after: { villaNumber: "P-001" } };

    expect(toDetailDto(detail, { locale: "ar", entityName: "P-001" })).toMatchObject({
      entity: "فيلا",
      entityCode: "Villa",
      entityName: "P-001",
      after: { villaNumber: "P-001" },
    });
  });

  it("has exactly these fields, in this order", () => {
    expect(Object.keys(toListItemDto(row(), { locale: "en" }))).toEqual([
      "id",
      "actor",
      "action",
      "actionLabel",
      "entity",
      "entityCode",
      "entityId",
      "entityName",
      "entityDetail",
      "ip",
      "userAgent",
      "requestId",
      "createdAt",
    ]);
  });
});

// A stand-in for the database client that records every query, so the number of statements is what is tested.
function stubDb(data: {
  villa?: Record<string, string>;
  contractor?: Record<string, string>;
  civilEngineer?: Record<string, string>;
  electricalEngineer?: Record<string, string>;
  elecPhase?: Record<string, string>;
  area?: Record<string, string>;
  user?: Record<string, string>;
  villaDocument?: Record<string, string>;
  auditLog?: Record<string, { before: unknown; after: unknown }>;
}) {
  const named = (table: Record<string, string> = {}, field: string) =>
    vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id in table).map((id) => ({ id, [field]: table[id] })),
    );
  const db = {
    villa: { findMany: named(data.villa, "villaNumber") },
    contractor: { findMany: named(data.contractor, "name") },
    civilEngineer: { findMany: named(data.civilEngineer, "name") },
    electricalEngineer: { findMany: named(data.electricalEngineer, "name") },
    elecPhase: { findMany: named(data.elecPhase, "name") },
    area: { findMany: named(data.area, "name") },
    user: { findMany: named(data.user, "name") },
    villaDocument: { findMany: named(data.villaDocument, "originalName") },
    auditLog: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in
          .filter((id) => data.auditLog && id in data.auditLog)
          .map((id) => ({ id, ...data.auditLog?.[id] })),
      ),
    },
  };
  const calls = () =>
    Object.fromEntries(
      Object.entries(db).map(([table, { findMany }]) => [table, findMany.mock.calls.length]),
    );
  const total = () => Object.values(calls()).reduce((sum, n) => sum + n, 0);
  return { db: db as unknown as Db, raw: db, calls, total };
}

const entry = (
  id: string,
  entity: string,
  entityId: string | null,
  extra: Partial<EntityNameRow> = {},
): EntityNameRow => ({
  id,
  entity,
  entityId,
  ...extra,
});

describe("AuditRepository.entityNames", () => {
  const repository = new AuditRepository();

  it("names each kind of entity from its own table", async () => {
    const { db } = stubDb({
      villa: { p1: "P-001" },
      contractor: { c1: "Nile Builders" },
      civilEngineer: { e1: "Mona Hassan" },
      electricalEngineer: { x1: "Omar Khaled" },
      elecPhase: { ph1: "Wall Piping" },
      area: { a1: "New Cairo" },
      user: { u1: "Sara" },
      villaDocument: { f1: "plan.pdf" },
    });

    const names = await repository.entityNames(
      [
        entry("1", "Villa", "p1"),
        entry("2", "Contractor", "c1"),
        entry("3", "CivilEngineer", "e1"),
        entry("6", "ElectricalEngineer", "x1"),
        entry("7", "ElecPhase", "ph1"),
        entry("8", "Area", "a1"),
        entry("4", "User", "u1"),
        entry("5", "VillaDocument", "f1"),
      ],
      db,
    );

    expect(Object.fromEntries(names)).toEqual({
      "1": "P-001",
      "2": "Nile Builders",
      "3": "Mona Hassan",
      "4": "Sara",
      "5": "plan.pdf",
      "6": "Omar Khaled",
      "7": "Wall Piping",
      "8": "New Cairo",
    });
  });

  describe("how many queries it runs", () => {
    it("is one per kind of entity, however many entries there are", async () => {
      const villas = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`p${i}`, `P-${i}`]));
      const contractors = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`c${i}`, `C ${i}`]));
      const stub = stubDb({ villa: villas, contractor: contractors });
      const entries = [
        ...Array.from({ length: 500 }, (_, i) => entry(`a${i}`, "Villa", `p${i}`)),
        ...Array.from({ length: 300 }, (_, i) => entry(`b${i}`, "Contractor", `c${i}`)),
      ];

      const names = await repository.entityNames(entries, stub.db);

      expect(names.size).toBe(800);
      expect(stub.calls()).toEqual({
        villa: 1,
        contractor: 1,
        civilEngineer: 0,
        electricalEngineer: 0,
        elecPhase: 0,
        area: 0,
        user: 0,
        villaDocument: 0,
        auditLog: 0,
      });
      expect(stub.total()).toBe(2);
    });

    it("never more than one per entity kind plus one for the snapshots of deleted records", async () => {
      const stub = stubDb({
        villa: { p1: "P-1" },
        auditLog: Object.fromEntries(
          Array.from({ length: 300 }, (_, i) => [`g${i}`, { before: { name: `Gone ${i}` }, after: null }]),
        ),
      });
      const entries = [
        entry("live", "Villa", "p1"),
        ...Array.from({ length: 300 }, (_, i) => entry(`g${i}`, "Contractor", `deleted-${i}`)),
        ...Array.from({ length: 200 }, (_, i) => entry(`u${i}`, "User", `missing-${i}`)),
        ...Array.from({ length: 100 }, (_, i) => entry(`e${i}`, "CivilEngineer", `missing-${i}`)),
        ...Array.from({ length: 100 }, (_, i) => entry(`f${i}`, "VillaDocument", `missing-${i}`)),
        ...Array.from({ length: 100 }, (_, i) => entry(`x${i}`, "ElectricalEngineer", `missing-${i}`)),
        ...Array.from({ length: 100 }, (_, i) => entry(`h${i}`, "ElecPhase", `missing-${i}`)),
        ...Array.from({ length: 100 }, (_, i) => entry(`r${i}`, "Area", `missing-${i}`)),
      ];

      await repository.entityNames(entries, stub.db);

      expect(stub.calls()).toEqual({
        villa: 1,
        contractor: 1,
        civilEngineer: 1,
        electricalEngineer: 1,
        elecPhase: 1,
        area: 1,
        user: 1,
        villaDocument: 1,
        auditLog: 1,
      });
      expect(stub.total()).toBe(9);
    });

    it("asks for each id once, however often it appears", async () => {
      const stub = stubDb({ villa: { p1: "P-1", p2: "P-2" } });
      const entries = Array.from({ length: 200 }, (_, i) => entry(`r${i}`, "Villa", i % 2 ? "p1" : "p2"));

      await repository.entityNames(entries, stub.db);

      expect(stub.raw.villa.findMany).toHaveBeenCalledTimes(1);
      const ids = (stub.raw.villa.findMany.mock.calls[0]?.[0] as { where: { id: { in: string[] } } }).where.id
        .in;
      expect([...ids].sort()).toEqual(["p1", "p2"]);
    });

    it("runs no query at all when there is nothing to look up", async () => {
      const stub = stubDb({});

      expect((await repository.entityNames([], stub.db)).size).toBe(0);
      await repository.entityNames(
        [
          entry("1", "Villa", null),
          entry("2", "Widget", "w1"),
          entry("3", "AuditLog", "a1"),
          entry("4", "Villa", null),
        ],
        stub.db,
      );

      expect(stub.total()).toBe(0);
    });

    it("does not fetch snapshots when every record was found", async () => {
      const stub = stubDb({ villa: { p1: "P-1" } });

      await repository.entityNames([entry("1", "Villa", "p1")], stub.db);

      expect(stub.raw.auditLog.findMany).not.toHaveBeenCalled();
    });

    it("does not fetch snapshots the caller already has (the detail view)", async () => {
      const stub = stubDb({});

      const names = await repository.entityNames(
        [entry("1", "Contractor", "gone", { before: { name: "Old Name" }, after: null })],
        stub.db,
      );

      expect(names.get("1")).toBe("Old Name");
      expect(stub.raw.auditLog.findMany).not.toHaveBeenCalled();
    });

    it("only fetches the snapshots of entries that need one", async () => {
      const stub = stubDb({
        villa: { p1: "P-1" },
        auditLog: { gone: { before: { villaNumber: "P-9" }, after: null } },
      });

      await repository.entityNames([entry("live", "Villa", "p1"), entry("gone", "Villa", "p9")], stub.db);

      expect(
        (stub.raw.auditLog.findMany.mock.calls[0]?.[0] as { where: { id: { in: string[] } } }).where.id.in,
      ).toEqual(["gone"]);
    });
  });

  describe("which name wins", () => {
    it("prefers the record as it is now over the entry's snapshot", async () => {
      const stub = stubDb({
        villa: { p1: "P-NEW" },
        auditLog: { "1": { before: null, after: { villaNumber: "P-OLD" } } },
      });

      const names = await repository.entityNames([entry("1", "Villa", "p1")], stub.db);

      expect(names.get("1")).toBe("P-NEW");
    });

    it("falls back to the snapshot when the record is gone: a delete's before, a create's after", async () => {
      const stub = stubDb({
        auditLog: {
          del: { before: { villaNumber: "P-DEL", status: "OPEN" }, after: null },
          cre: { before: null, after: { villaNumber: "P-CRE" } },
        },
      });

      const names = await repository.entityNames(
        [entry("del", "Villa", "x1"), entry("cre", "Villa", "x2")],
        stub.db,
      );

      expect(Object.fromEntries(names)).toEqual({ del: "P-DEL", cre: "P-CRE" });
    });

    it("prefers the after snapshot over the before one", async () => {
      const stub = stubDb({ auditLog: { "1": { before: { name: "Before" }, after: { name: "After" } } } });

      const names = await repository.entityNames([entry("1", "Contractor", "gone")], stub.db);

      expect(names.get("1")).toBe("After");
    });

    it("leaves an entry out when neither the record nor the snapshot has a name", async () => {
      const stub = stubDb({ auditLog: { "1": { before: { status: "OPEN" }, after: { status: "CLOSED" } } } });

      const names = await repository.entityNames([entry("1", "Villa", "gone")], stub.db);

      expect(names.has("1")).toBe(false);
    });

    it("a name in the snapshot of another kind of entity is not used", async () => {
      const stub = stubDb({ auditLog: { "1": { before: null, after: { villaNumber: "P-1" } } } });

      const names = await repository.entityNames([entry("1", "Contractor", "gone")], stub.db);

      expect(names.has("1")).toBe(false);
    });

    it("entries with no entity id get no name, even when their snapshot has one", async () => {
      const stub = stubDb({});

      const names = await repository.entityNames(
        [entry("1", "Villa", null, { after: { villaNumber: "P-1" } })],
        stub.db,
      );

      expect(names.size).toBe(0);
    });

    it("names the same record the same way for every entry about it", async () => {
      const stub = stubDb({ contractor: { c1: "Nile Builders" } });

      const names = await repository.entityNames(
        [entry("a", "Contractor", "c1"), entry("b", "Contractor", "c1"), entry("c", "Contractor", "c1")],
        stub.db,
      );

      expect([...names.values()]).toEqual(["Nile Builders", "Nile Builders", "Nile Builders"]);
    });

    it("does not confuse two entities that share an id", async () => {
      const stub = stubDb({ villa: { same: "P-1" }, contractor: { same: "Nile" } });

      const names = await repository.entityNames(
        [entry("1", "Villa", "same"), entry("2", "Contractor", "same")],
        stub.db,
      );

      expect(Object.fromEntries(names)).toEqual({ "1": "P-1", "2": "Nile" });
    });
  });
});

describe("legacy entity codes", () => {
  it("maps Project and ProjectFile to today's entities, and leaves every other code alone", () => {
    expect(canonicalEntity("Project")).toBe("Villa");
    expect(canonicalEntity("ProjectFile")).toBe("VillaDocument");
    for (const code of [...CODES, "Widget"]) expect(canonicalEntity(code)).toBe(code);
  });

  it("lists every code stored for an entity, today's first", () => {
    expect(entityCodes("Villa")).toEqual(["Villa", "Project"]);
    expect(entityCodes("Project")).toEqual(["Villa", "Project"]);
    expect(entityCodes("VillaDocument")).toEqual(["VillaDocument", "ProjectFile"]);
    expect(entityCodes("ProjectFile")).toEqual(["VillaDocument", "ProjectFile"]);
    expect(entityCodes("Contractor")).toEqual(["Contractor"]);
  });

  it("labels the legacy codes as the entity they stand for", () => {
    expect(entityLabel("Project", "en")).toBe("Villa");
    expect(entityLabel("Project", "ar")).toBe("فيلا");
    expect(entityLabel("ProjectFile", "en")).toBe("Villa document");
    expect(entityLabel("ProjectFile", "ar")).toBe("مستند الفيلا");
  });

  it("reads the old field names from legacy snapshots", () => {
    expect(nameFromSnapshots("Project", { projectNumber: "P-1" })).toBe("P-1");
    expect(nameFromSnapshots("Project", { villaNumber: "V-1" })).toBeNull();
    expect(nameFromSnapshots("Villa", { villaNumber: "V-1" })).toBe("V-1");
    expect(nameFromSnapshots("ProjectFile", { originalName: "a.pdf" })).toBe("a.pdf");
  });
});
