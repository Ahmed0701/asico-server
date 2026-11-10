import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import ExcelJS from "exceljs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readPdf } from "../../shared/export/helpers.js";
import { addArea } from "../areas/in-memory-areas.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addAuditRow } from "../audit/in-memory-audit.repository.js";
import {
  addEngineer,
  addVillaFor,
  engineerTables,
} from "../civil-engineers/in-memory-civil-engineers.repository.js";
import {
  addElectricalEngineer,
  electricalTables,
} from "../electrical-engineers/in-memory-electrical-engineers.repository.js";
import {
  addContractor,
  addVilla as addContractorVilla,
  contractorTables,
  linkVilla,
} from "../contractors/in-memory-contractors.repository.js";
import { addPhase, phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { progressTables } from "../villa-progress/progress-tables.js";
import { InMemoryVillasRepository, addVilla, villaTables } from "../villas/in-memory-villas.repository.js";
import { addWorkItem, workItemTables } from "../open-works/in-memory-open-works.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/contractors/repository/contractors.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/contractors/repository/contractors.repository.js")
  >()),
  ContractorsRepository: (await import("../contractors/in-memory-contractors.repository.js"))
    .InMemoryContractorsRepository,
}));
vi.mock(
  "../../../src/modules/civil-engineers/repository/civil-engineers.repository.js",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/modules/civil-engineers/repository/civil-engineers.repository.js")
    >()),
    CivilEngineersRepository: (await import("../civil-engineers/in-memory-civil-engineers.repository.js"))
      .InMemoryCivilEngineersRepository,
  }),
);
vi.mock(
  "../../../src/modules/electrical-engineers/repository/electrical-engineers.repository.js",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/modules/electrical-engineers/repository/electrical-engineers.repository.js")
    >()),
    ElectricalEngineersRepository: (
      await import("../electrical-engineers/in-memory-electrical-engineers.repository.js")
    ).InMemoryElectricalEngineersRepository,
  }),
);
vi.mock("../../../src/modules/areas/repository/areas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/areas/repository/areas.repository.js")>()),
  AreasRepository: (await import("../areas/in-memory-areas.repository.js")).InMemoryAreasRepository,
}));
vi.mock("../../../src/modules/open-works/repository/open-works.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/open-works/repository/open-works.repository.js")
  >()),
  OpenWorksRepository: (await import("../open-works/in-memory-open-works.repository.js"))
    .InMemoryOpenWorksRepository,
}));
vi.mock("../../../src/modules/audit/repository/audit.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/audit/repository/audit.repository.js")>()),
  AuditRepository: (await import("../audit/in-memory-audit.repository.js")).InMemoryAuditRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { setPhaseOpenWork } from "../open-works/work-item-tables.js";

const app = createApp();
const MISSING_ID = randomUUID();
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const todayUtc = (): string => new Date().toISOString().slice(0, 10);
const original = { limit: env.EXPORT_RATE_LIMIT_MAX };

let admin: User;
let eng1: ReturnType<typeof addEngineer>;
let eng2: ReturnType<typeof addEngineer>;
let conA: ReturnType<typeof addContractor>;
let conB: ReturnType<typeof addContractor>;

beforeEach(() => {
  vi.restoreAllMocks();
  store.reset();
  engineerTables.reset();
  electricalTables.reset();
  contractorTables.reset();
  villaTables.reset();
  phaseTables.reset();
  workItemTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  eng1 = addEngineer({ name: "Mona Hassan", phone: "0100 123 4567" });
  eng2 = addEngineer({ name: "منى حسن", phone: "0101 765 4321" });
  conA = addContractor({ name: "Nile Builders", phone: "0102 000 0001" });
  conB = addContractor({ name: "شركة النيل", phone: "0102 000 0002" });
});

afterEach(() => {
  env.EXPORT_RATE_LIMIT_MAX = original.limit;
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

// A file response is read as raw bytes.
const binary = (response: request.Response, done: (err: Error | null, body: Buffer) => void): void => {
  const incoming = response as unknown as http.IncomingMessage;
  const chunks: Buffer[] = [];
  incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
  incoming.on("end", () => done(null, Buffer.concat(chunks)));
};

const download = async (path: string, user: User = admin, language = "en") =>
  request(app)
    .get(`/api/v1${path}`)
    .set(await as(user))
    .set("Accept-Language", language)
    .buffer(true)
    .parse(binary as never);

const getJson = async (path: string, user: User = admin, language = "en") =>
  request(app)
    .get(`/api/v1${path}`)
    .set(await as(user))
    .set("Accept-Language", language);

const DEFAULT_COLUMN_WIDTH = 9.140625;

async function sheetOf(res: request.Response): Promise<ExcelJS.Worksheet> {
  expect(res.status).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body as unknown as ArrayBuffer);
  return workbook.worksheets[0]!;
}

// The data rows of a sheet as objects keyed by the header titles (after any summary block above the header).
function tableOf(sheet: ExcelJS.Worksheet, headerRow = 1): Record<string, ExcelJS.CellValue>[] {
  const titles = (sheet.getRow(headerRow).values as ExcelJS.CellValue[]).slice(1) as string[];
  const rows: Record<string, ExcelJS.CellValue>[] = [];
  for (let n = headerRow + 1; n <= sheet.rowCount; n++) {
    const values = (sheet.getRow(n).values as ExcelJS.CellValue[]).slice(1);
    rows.push(Object.fromEntries(titles.map((title, i) => [title, values[i] ?? null])));
  }
  return rows;
}

const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const exportAudits = () => auditRows().filter((row) => String(row["action"]).startsWith("export."));

// Six villas over four areas, two engineers and two contractors (a villa has one contractor, or none).
function seedVillas() {
  const elec1 = addElectricalEngineer({ name: "Hany Wagdy", phone: "0103 111 2222" });
  const mk = (n: number, o: Parameters<typeof addVilla>[0]) =>
    addVilla({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      villaNumber: `P-00${n}`,
      plot: String(9 + n),
      createdAt: day(`2026-01-0${n}`),
      ...o,
    });
  const p1 = mk(1, {
    area: "New Cairo",
    block: "B1",
    ownerName: "Khaled Mansour",
    civilEngineerId: eng1.id,
    electricalEngineerId: elec1.id,
    contractorId: conA.id,
    startDate: day("2026-01-05"),
    targetDate: day("2026-03-01"),
    budgetMinor: 1_250_500,
    currency: "KWD",
  });
  const p2 = mk(2, {
    area: "New Cairo",
    block: "B2",
    civilEngineerId: eng1.id,
    contractorId: conA.id,
    targetDate: day("2026-02-01"),
  });
  const p3 = mk(3, {
    area: "Sheikh Zayed",
    block: "B1",
    civilEngineerId: eng2.id,
    contractorId: conB.id,
    budgetMinor: 125050,
    currency: "EGP",
  });
  const p4 = mk(4, {
    area: "القاهرة الجديدة",
    block: "B3",
    ownerName: "منى سمير",
    budgetMinor: 5,
    currency: "JPY",
    civilEngineerId: eng2.id,
    contractorId: conB.id,
    startDate: day("2026-01-04"),
  });
  const p5 = mk(5, { area: "6 October", block: "B2", civilEngineerId: eng1.id });
  const p6 = mk(6, { area: "6 October", block: "B7", civilEngineerId: eng2.id });
  return { p1, p2, p3, p4, p5, p6 };
}

const everyPermission = [
  "villas:read",
  "villas:detail",
  "villas:create",
  "villas:update",
  "villas:delete",
  "villas:export",
  "open-works:read",
  "open-works:export",
  "open-works:import",
  "contractors:read",
  "contractors:create",
  "contractors:update",
  "contractors:delete",
  "contractors:summary",
  "civil-engineers:read",
  "civil-engineers:create",
  "civil-engineers:update",
  "civil-engineers:delete",
  "electrical-engineers:read",
  "areas:read",
  "audit:read",
  "villa-documents:upload",
  "villa-documents:download",
  "villa-documents:delete",
];

const endpoints: [string, () => string, string, string, string][] = [
  ["villas", () => "/villas/export", "villas:export", "export.villas", "Villa"],
  ["open works", () => "/open-works/export", "open-works:export", "export.open-works", "WorkItem"],
  ["contractors", () => "/contractors/export", "contractors:read", "export.contractors", "Contractor"],
  [
    "civil engineers",
    () => "/civil-engineers/export",
    "civil-engineers:read",
    "export.civil-engineers",
    "CivilEngineer",
  ],
  [
    "contractor summary",
    () => `/contractors/${conA.id}/summary/export`,
    "contractors:summary",
    "export.contractor-summary",
    "Contractor",
  ],
  ["audit log", () => "/audit-logs/export", "audit:read", "export.audit-logs", "AuditLog"],
  [
    "electrical engineers",
    () => "/electrical-engineers/export",
    "electrical-engineers:read",
    "export.electrical-engineers",
    "ElectricalEngineer",
  ],
  ["areas", () => "/areas/export", "areas:read", "export.areas", "Area"],
];

// Every export, read back: each column has a width of its own (not the spreadsheet's default), within 8..60, and
// at least as wide as the longest line in it, the header and any summary block above it included.
describe("column widths of every xlsx export", () => {
  const longestLine = (text: string): number =>
    Math.max(0, ...text.split(/\r\n|\r|\n/).map((line) => line.length));

  it.each(endpoints)(
    "%s: no column has the default width or is narrower than its longest cell",
    async (_name, path) => {
      const { p1 } = seedVillas();
      addWorkItem({
        villaId: p1.id,
        endDate: day("2026-12-31"),
      });
      const sheet = await sheetOf(await download(`${path()}?format=xlsx`));

      expect(sheet.columnCount).toBeGreaterThan(0);
      for (let number = 1; number <= sheet.columnCount; number++) {
        const column = sheet.getColumn(number);
        let longest = 0;
        column.eachCell({ includeEmpty: false }, (cell) => {
          // A date shows as its format does (the date, or the timestamp and "UTC"), not as the date's own text.
          const shown = cell.value instanceof Date ? cell.numFmt.replaceAll('"', "") : cell.text;
          longest = Math.max(longest, longestLine(shown));
        });

        expect(column.width, `column ${number} has a width`).toBeDefined();
        expect(column.width).not.toBe(DEFAULT_COLUMN_WIDTH);
        expect(column.width).toBeGreaterThanOrEqual(8);
        expect(column.width).toBeLessThanOrEqual(60);
        expect(column.width, `column ${number} fits its longest cell (${longest})`).toBeGreaterThanOrEqual(
          Math.min(60, longest),
        );
      }
    },
  );
});

describe("access control", () => {
  it.each(endpoints)("%s: requires authentication (401)", async (_name, path) => {
    const res = await request(app).get(`/api/v1${path()}?format=xlsx`);

    expect(res.status).toBe(401);
  });

  it.each(endpoints)("%s: answers 403 to an employee with no permissions, in Arabic", async (_name, path) => {
    const res = await download(`${path()}?format=xlsx`, employee("e@example.test"), "ar");

    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString())).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });

  it.each(endpoints)("%s: is not opened by any other permission", async (_name, path, needed) => {
    const others = everyPermission.filter((code) => code !== needed);

    const res = await download(`${path()}?format=xlsx`, employee("e@example.test", ...others));

    expect(res.status).toBe(403);
  });

  it.each(endpoints)("%s: lets the holder of %s through (xlsx and pdf)", async (_name, path, needed) => {
    const user = employee("e@example.test", needed);

    expect((await download(`${path()}?format=xlsx`, user)).status).toBe(200);
    expect((await download(`${path()}?format=pdf`, user)).status).toBe(200);
  });

  it.each(endpoints)("%s: lets the ADMIN through with no granted permissions", async (_name, path) => {
    expect((await download(`${path()}?format=xlsx`)).status).toBe(200);
  });

  it("each permission opens only its own export", async () => {
    for (const [name, , needed] of endpoints) {
      const user = employee(`${needed}@example.test`, needed);
      for (const [other, otherPath, otherNeeded] of endpoints) {
        if (otherNeeded === needed) continue;
        const res = await download(`${otherPath()}?format=xlsx`, user);
        expect(res.status, `${needed} (${name}) on ${other}`).toBe(403);
      }
    }
  });

  it("read access to the list does not allow the export, and the export does not allow the list", async () => {
    seedVillas();
    const reader = employee("r@example.test", "villas:read", "contractors:summary");
    const exporter = employee("x@example.test", "villas:export");

    expect((await download("/villas/export?format=xlsx", reader)).status).toBe(403);
    expect((await getJson("/villas", exporter)).status).toBe(403);
  });

  it("a refused request writes no audit row and uses none of the export allowance", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 1;
    // The same person is refused (no contractors:read) three times, then asks for what they may export.
    const user = employee("e@example.test", "villas:export");
    for (let i = 0; i < 3; i++) {
      expect((await download("/contractors/export?format=xlsx", user)).status).toBe(403);
    }

    expect((await download("/villas/export?format=xlsx", user)).status).toBe(200);
    expect(exportAudits()).toHaveLength(1);
  });

  it("checks access before validating", async () => {
    const res = await download("/villas/export?format=bogus&sort=bogus", employee("e@example.test"));

    expect(res.status).toBe(403);
  });
});

describe("validation", () => {
  it.each(endpoints)("%s: a missing format is 400, in Arabic, naming the field", async (_name, path) => {
    const res = await download(path(), admin, "ar");

    const body = JSON.parse(res.body.toString());
    expect(res.status).toBe(400);
    expect(body).toMatchObject({ code: "VALIDATION_ERROR", message: "فشل التحقق" });
    expect(body.details).toContainEqual({ path: "format", message: "يجب أن تكون الصيغة xlsx أو pdf" });
  });

  it.each(["csv", "XLSX", "Pdf", "xls", "", "json", "xlsx,pdf"])("format=%j is 400", async (value) => {
    const res = await download(`/villas/export?format=${encodeURIComponent(value)}`);

    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString()).details[0].path).toBe("format");
  });

  it("a repeated format is 400", async () => {
    expect((await download("/villas/export?format=xlsx&format=pdf")).status).toBe(400);
  });

  it.each([["page=1"], ["limit=10"], ["page=2&limit=5"], ["limit=1000"]])(
    "%s is refused: an export has no paging",
    async (query) => {
      const res = await download(`/villas/export?format=xlsx&${query}`, admin, "ar");

      const body = JSON.parse(res.body.toString());
      expect(res.status).toBe(400);
      expect(body.details.map((d: { path: string }) => d.path).sort()).toEqual(
        query
          .split("&")
          .map((part) => part.split("=")[0])
          .sort(),
      );
      expect(body.details[0].message).toBe(
        "لا يمكن تحديد الصفحة والحد في التصدير: فهو يشمل كل السجلات المطابقة",
      );
      expect(exportAudits()).toHaveLength(0);
    },
  );

  it("paging is refused on every export", async () => {
    for (const [name, path] of endpoints) {
      expect((await download(`${path()}?format=xlsx&limit=5`)).status, name).toBe(400);
    }
  });

  it("filters are validated exactly as the list validates them", async () => {
    const bad = [
      "civilEngineerId=nope",
      "contractorId=nope",
      "startFrom=2026-13-45",
      "startFrom=2026-02-01&startTo=2026-01-01",
      "targetFrom=2026-02-01&targetTo=2026-01-01",
      "sort=bogus",
      "area=",
      `search=${"x".repeat(101)}`,
    ];
    for (const query of bad) {
      const viaExport = await download(`/villas/export?format=xlsx&${query}`, admin, "ar");
      const viaList = await getJson(`/villas?${query}`, admin, "ar");

      expect(viaExport.status, query).toBe(400);
      expect(viaList.status, query).toBe(400);
      expect(JSON.parse(viaExport.body.toString()).details, query).toEqual(viaList.body.details);
    }
  });

  it("reports the format error together with filter errors", async () => {
    const res = await download("/villas/export?format=bogus&contractorId=nope&limit=5");

    const paths = JSON.parse(res.body.toString()).details.map((d: { path: string }) => d.path);
    expect(paths.sort()).toEqual(["contractorId", "format", "limit"]);
  });

  it("an unknown parameter is ignored, as on the list", async () => {
    seedVillas();

    expect((await download("/villas/export?format=xlsx&bogus=1")).status).toBe(200);
  });

  it("audit and contractor filters are validated like their lists", async () => {
    for (const [exportPath, listPath, query] of [
      ["/audit-logs/export", "/audit-logs", "from=2026-02-01&to=2026-01-01"],
      ["/audit-logs/export", "/audit-logs", "actorId=nope"],
      ["/contractors/export", "/contractors", "sort=bogus"],
      ["/civil-engineers/export", "/civil-engineers", "sort=bogus"],
      [`/contractors/${conA.id}/summary/export`, `/contractors/${conA.id}/summary`, "sort=bogus"],
    ] as const) {
      const viaExport = await download(`${exportPath}?format=xlsx&${query}`, admin, "ar");
      const viaList = await getJson(`${listPath}?${query}`, admin, "ar");

      expect(viaExport.status, `${exportPath} ${query}`).toBe(400);
      expect(JSON.parse(viaExport.body.toString()).details, query).toEqual(viaList.body.details);
    }
  });

  it("the contractor summary export answers 400 for a malformed id", async () => {
    expect((await download("/contractors/nope/summary/export?format=xlsx")).status).toBe(400);
  });
});

describe("response headers", () => {
  const types = {
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pdf: "application/pdf",
  } as const;
  const stems = [
    "villas",
    "open-works",
    "contractors",
    "civil-engineers",
    "contractor-summary",
    "audit-logs",
    "electrical-engineers",
    "areas",
  ];

  it.each(endpoints.map((e, i) => [e[0], e[1], stems[i]!] as const))(
    "%s: right content type, attachment name with the UTC date, no caching, English",
    async (_name, path, stem) => {
      for (const format of ["xlsx", "pdf"] as const) {
        const res = await download(`${path()}?format=${format}`, admin, "ar");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toBe(types[format]);
        expect(res.headers["content-disposition"]).toBe(
          `attachment; filename="asico-${stem}-${todayUtc()}.${format}"`,
        );
        expect(res.headers["cache-control"]).toBe("private, no-store");
        expect(res.headers["content-language"]).toBe("en");
      }
    },
  );

  it("the file name is plain ASCII", async () => {
    const res = await download("/villas/export?format=xlsx", admin, "ar");

    expect(res.headers["content-disposition"]).toMatch(/^[\x20-\x7E]*$/);
  });

  it("an error response carries no file headers and follows the request language", async () => {
    const res = await download("/villas/export", admin, "ar");

    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(res.headers["content-language"]).toBeUndefined();
  });

  it("an xlsx is a zip and a pdf starts with %PDF-", async () => {
    seedVillas();

    expect((await download("/villas/export?format=xlsx")).body.subarray(0, 2).toString()).toBe("PK");
    expect((await download("/villas/export?format=pdf")).body.subarray(0, 5).toString()).toBe("%PDF-");
  });
});

type ListItem = {
  villaNumber: string;
  area: string;
  block: string;
  plot: string;
  ownerName: string | null;
  civilEngineer: { name: string };
  electricalEngineer: { name: string } | null;
  contractor: { name: string } | null;
  startDate: string | null;
  targetDate: string | null;
  budgetMinor: number | null;
  currency: string | null;
  createdAt: string;
};

describe("the same rows as the list", () => {
  const queries = [
    "",
    "area=new%20cairo",
    "block=B1",
    "plot=11",
    "search=mona",
    "search=khaled",
    "search=hany",
    "sort=location",
    "sort=villaNumber",
    "sort=villaNumber:desc",
    "sort=location:desc",
    "sort=targetDate",
    "sort=targetDate:desc",
    "startFrom=2026-01-04&startTo=2026-01-05",
    "targetFrom=2026-02-01",
    "area=new%20cairo&sort=villaNumber:desc",
    "search=zzz-nothing",
  ];

  it.each(queries)("villas export for ?%s lists what /villas lists, in the same order", async (query) => {
    seedVillas();
    const joiner = query ? "&" : "";

    const list = await getJson(`/villas?limit=1000${joiner}${query}`);
    const sheet = await sheetOf(await download(`/villas/export?format=xlsx${joiner}${query}`));

    expect(tableOf(sheet).map((row) => row["Villa Number"])).toEqual(
      list.body.data.map((item: { villaNumber: string }) => item.villaNumber),
    );
  });

  it("villas: every column matches the list item", async () => {
    seedVillas();
    const list = await getJson("/villas?limit=1000&sort=villaNumber");
    const rows = tableOf(await sheetOf(await download("/villas/export?format=xlsx&sort=villaNumber")));

    list.body.data.forEach((item: ListItem, index: number) => {
      const row = rows[index]!;
      expect(row["Villa Number"]).toBe(item.villaNumber);
      expect(row["Owner Name"] ?? "").toBe(item.ownerName ?? "");
      expect(row["Area"]).toBe(item.area);
      expect(row["Block"]).toBe(item.block);
      expect(row["Plot"]).toBe(item.plot);
      expect(row["Civil Engineer"]).toBe(item.civilEngineer.name);
      expect(row["Electrical Engineer"] ?? "").toBe(item.electricalEngineer?.name ?? "");
      expect(row["Contractor"] ?? "").toBe(item.contractor?.name ?? "");
      expect(row["Start Date"] ?? null).toEqual(item.startDate ? new Date(item.startDate) : null);
      expect(row["Target Date"] ?? null).toEqual(item.targetDate ? new Date(item.targetDate) : null);
      expect(row["Budget"] ?? null).toBe(
        item.budgetMinor === null ? null : { KWD: 1250.5, EGP: 1250.5, JPY: 5 }[item.currency ?? ""],
      );
      expect(row["Currency"] ?? null).toBe(item.budgetMinor === null ? null : item.currency);
      expect(row["Created (UTC)"]).toEqual(new Date(item.createdAt));
    });
  });

  it("villas: the budget is a number in the currency's own units beside its code, and empty without one", async () => {
    seedVillas();

    const rows = tableOf(await sheetOf(await download("/villas/export?format=xlsx&sort=villaNumber")));

    expect(rows.map((row) => row["Budget"] ?? null)).toEqual([1250.5, null, 1250.5, 5, null, null]);
    expect(rows.map((row) => row["Currency"] ?? null)).toEqual(["KWD", null, "EGP", "JPY", null, null]);
  });

  it("villas: the budget is shown with the decimals of its own currency: three for KWD, two for EGP, none for JPY", async () => {
    seedVillas();

    const sheet = await sheetOf(await download("/villas/export?format=xlsx&sort=villaNumber"));
    const budget = (sheet.getRow(1).values as ExcelJS.CellValue[]).indexOf("Budget");

    // Rows 2, 4 and 5 are the villas with a budget (KWD, EGP, JPY).
    expect([2, 4, 5].map((row) => sheet.getRow(row).getCell(budget).numFmt)).toEqual([
      "#,##0.000",
      "#,##0.00",
      "#,##0",
    ]);
  });

  it("villas: a villa without a contractor has an empty contractor cell", async () => {
    seedVillas();

    const rows = tableOf(await sheetOf(await download("/villas/export?format=xlsx&sort=villaNumber")));

    expect(rows[0]!["Contractor"]).toBe("Nile Builders");
    expect(rows[4]!["Contractor"] ?? null).toBeNull();
  });

  it("villas: the progress column shows the figure the list shows, as text with one decimal", async () => {
    const { p1, p2 } = seedVillas();
    // One counts 60, Two 40, once the villa's open work for it is done.
    const [one, two] = [
      addPhase({ name: "One", progressRatio: 60 }),
      addPhase({ name: "Two", progressRatio: 40 }),
    ];
    progressTables.insertMissing([
      { villaId: p1.id, elecPhaseId: one.id },
      { villaId: p1.id, elecPhaseId: two.id },
      { villaId: p2.id, elecPhaseId: one.id },
    ]);
    progressTables.find(p1.id, one.id)!.progress = 100;
    progressTables.find(p1.id, two.id)!.progress = 25;
    progressTables.find(p2.id, one.id)!.progress = 1;
    // P1 has One done (60) and Two at 25 (not yet counted); P2 has One at 1 (not counted).
    setPhaseOpenWork(p1.id, one.id, 100);
    setPhaseOpenWork(p1.id, two.id, 25);
    setPhaseOpenWork(p2.id, one.id, 1);

    const list = await getJson("/villas?limit=1000&sort=villaNumber");
    const rows = tableOf(await sheetOf(await download("/villas/export?format=xlsx&sort=villaNumber")));

    expect(list.body.data.map((item: { progress: number }) => item.progress)).toEqual([60, 0, 0, 0, 0, 0]);
    expect(rows.map((row) => row["Progress"])).toEqual(["60.0%", "0.0%", "0.0%", "0.0%", "0.0%", "0.0%"]);
  });

  it("the villas export has no status, checklist, material request, contractor list or ready column any more", async () => {
    seedVillas();

    const sheet = await sheetOf(await download("/villas/export?format=xlsx"));

    const titles = (sheet.getRow(1).values as string[]).slice(1);
    for (const gone of [
      "Status",
      "Checklist Completed",
      "Material Request (MR)",
      "Contractors",
      "Ready",
      "Ready Date",
    ]) {
      expect(titles).not.toContain(gone);
    }
  });

  // The open works have their module since slice 9a; their export comes with 9b, and then has its own tests.
  it("the wall-piping export is gone", async () => {
    expect((await download("/wall-piping/export?format=xlsx")).status).toBe(404);
  });

  it.each(["", "search=nile", "sort=name:desc", "sort=createdAt"])(
    "contractors export for ?%s lists what /contractors lists",
    async (query) => {
      addContractor({ name: "Giza Co", phone: "0102 000 0003" });
      const villaA = addContractorVilla();
      linkVilla(conA.id, villaA.id);
      const joiner = query ? "&" : "";

      const list = await getJson(`/contractors?limit=1000${joiner}${query}`);
      const rows = tableOf(await sheetOf(await download(`/contractors/export?format=xlsx${joiner}${query}`)));

      expect(rows.map((row) => row["Name"])).toEqual(list.body.data.map((c: { name: string }) => c.name));
      expect(rows.map((row) => row["Phone"])).toEqual(list.body.data.map((c: { phone: string }) => c.phone));
      expect(rows.map((row) => row["Villas"])).toEqual(
        list.body.data.map((c: { villaCount: number }) => c.villaCount),
      );
    },
  );

  it.each(["", "search=mona", "sort=name:desc"])(
    "civil engineers export for ?%s lists what /civil-engineers lists",
    async (query) => {
      addVillaFor(eng1.id, 3);
      const joiner = query ? "&" : "";

      const list = await getJson(`/civil-engineers?limit=1000${joiner}${query}`);
      const rows = tableOf(
        await sheetOf(await download(`/civil-engineers/export?format=xlsx${joiner}${query}`)),
      );

      expect(rows.map((row) => row["Name"])).toEqual(list.body.data.map((c: { name: string }) => c.name));
      expect(rows.map((row) => row["Villas"])).toEqual(
        list.body.data.map((c: { villaCount: number }) => c.villaCount),
      );
    },
  );

  describe("electrical engineers", () => {
    beforeEach(() => {
      addElectricalEngineer({ name: "Omar Khaled", phone: "0100 111 2222" });
      addElectricalEngineer({ name: "Laila Said", phone: "0101 333 4444" });
      addElectricalEngineer({ name: "أحمد علي", phone: "0102 555 6666" });
    });

    it.each(["", "search=omar", "sort=name:desc", "sort=createdAt"])(
      "lists what /electrical-engineers lists for ?%s",
      async (query) => {
        const joiner = query ? "&" : "";

        const list = await getJson(`/electrical-engineers?limit=1000${joiner}${query}`);
        const rows = tableOf(
          await sheetOf(await download(`/electrical-engineers/export?format=xlsx${joiner}${query}`)),
        );

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map((row) => row["Name"])).toEqual(list.body.data.map((c: { name: string }) => c.name));
        expect(rows.map((row) => row["Phone"])).toEqual(
          list.body.data.map((c: { phone: string }) => c.phone),
        );
        expect(rows.map((row) => row["Villas"])).toEqual(
          list.body.data.map((c: { villaCount: number }) => c.villaCount),
        );
      },
    );

    it("has English column titles whatever the request language, with the villa count", async () => {
      const res = await download("/electrical-engineers/export?format=xlsx", admin, "ar");
      const sheet = await sheetOf(res);

      expect((sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1)).toEqual([
        "Name",
        "Phone",
        "Email",
        "Status",
        "Villas",
        "Created (UTC)",
      ]);
      expect(sheet.name).toBe("Electrical Engineers");
      expect(res.headers["content-disposition"]).toContain("electrical-engineers-");
    });

    it("is a pdf too", async () => {
      const res = await download("/electrical-engineers/export?format=pdf");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      expect(JSON.stringify(await readPdf(res.body))).toContain("Electrical Engineers");
    });

    it("writes the export audit row with the engineer entity and the row count, never the data", async () => {
      await download("/electrical-engineers/export?format=xlsx");

      expect(exportAudits()).toHaveLength(1);
      expect(exportAudits()[0]).toMatchObject({
        action: "export.electrical-engineers",
        entity: "ElectricalEngineer",
        after: { rowCount: 3 },
      });
      expect(JSON.stringify(exportAudits())).not.toContain("Omar");
    });

    it("refuses a page or limit, a bad sort and a bad format with 400", async () => {
      for (const query of ["page=2", "limit=5", "sort=phone", "format=csv"]) {
        const res = await download(
          `/electrical-engineers/export?${query.startsWith("format") ? query : `format=xlsx&${query}`}`,
        );

        expect(res.status, query).toBe(400);
      }
    });
  });

  describe("areas", () => {
    beforeEach(() => {
      const palm = addArea({ name: "Palm Hills", city: "Giza" });
      const cairo = addArea({ name: "New Cairo", city: "Cairo" });
      addArea({ name: "Sheikh Zayed", city: "Giza" });
      addArea({ name: "الشروق", city: "Cairo" });
      addVilla({ areaId: palm.id });
      addVilla({ areaId: palm.id });
      addVilla({ areaId: cairo.id });
    });

    it.each(["", "search=giza", "search=zayed", "sort=villaCount:desc", "sort=city", "sort=createdAt:desc"])(
      "lists what /areas lists for ?%s, villa counts included",
      async (query) => {
        const joiner = query ? "&" : "";

        const list = await getJson(`/areas?limit=1000${joiner}${query}`);
        const rows = tableOf(await sheetOf(await download(`/areas/export?format=xlsx${joiner}${query}`)));

        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map((row) => row["Name"])).toEqual(list.body.data.map((a: { name: string }) => a.name));
        expect(rows.map((row) => row["City"])).toEqual(list.body.data.map((a: { city: string }) => a.city));
        expect(rows.map((row) => row["Villas"])).toEqual(
          list.body.data.map((a: { villaCount: number }) => a.villaCount),
        );
      },
    );

    it("counts the villas of each area as a number, and an empty area as 0", async () => {
      const rows = tableOf(await sheetOf(await download("/areas/export?format=xlsx&sort=villaCount:desc")));

      expect(rows.map((row) => [row["Name"], row["Villas"]])).toEqual([
        ["Palm Hills", 2],
        ["New Cairo", 1],
        ["Sheikh Zayed", 0],
        ["الشروق", 0],
      ]);
    });

    it("has English column titles whatever the request language", async () => {
      const res = await download("/areas/export?format=xlsx", admin, "ar");
      const sheet = await sheetOf(res);

      expect((sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1)).toEqual([
        "Name",
        "City",
        "Villas",
        "Created (UTC)",
      ]);
      expect(sheet.name).toBe("Areas");
      expect(res.headers["content-disposition"]).toContain("areas-");
    });

    it("is a pdf too, with the search written under the title", async () => {
      const res = await download("/areas/export?format=pdf&search=giza");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("application/pdf");
      const text = JSON.stringify(await readPdf(res.body));
      expect(text).toContain("Areas");
      expect(text).toContain("Search: giza");
    });

    it("writes the export audit row with the area entity and the row count, never the data", async () => {
      await download("/areas/export?format=xlsx");

      expect(exportAudits()).toHaveLength(1);
      expect(exportAudits()[0]).toMatchObject({
        action: "export.areas",
        entity: "Area",
        after: { rowCount: 4 },
      });
      expect(JSON.stringify(exportAudits())).not.toContain("Palm");
    });

    it("refuses a page or limit, a bad sort and a bad format with 400", async () => {
      for (const query of ["page=2", "limit=5", "sort=id", "format=csv"]) {
        const res = await download(
          `/areas/export?${query.startsWith("format") ? query : `format=xlsx&${query}`}`,
        );

        expect(res.status, query).toBe(400);
      }
    });
  });

  describe.each([
    { path: "civil-engineers", add: addEngineer, title: "Civil Engineers" },
    { path: "contractors", add: addContractor, title: "Contractors" },
    { path: "electrical-engineers", add: addElectricalEngineer, title: "Electrical Engineers" },
  ])("email and status in the $path export", ({ path, add }) => {
    beforeEach(() => {
      add({ name: "Zed Active", phone: "0100 900 0001", email: "zed@acme.test" });
      add({ name: "Yara Inactive", phone: "0100 900 0002", email: "yara@other.test", status: "INACTIVE" });
      add({ name: "Xena Nomail", phone: "0100 900 0003", status: "INACTIVE" });
    });

    it.each([
      "",
      "status=INACTIVE",
      "status=ACTIVE",
      "search=acme",
      "search=other.test",
      "status=INACTIVE&search=other",
      "status=ACTIVE&search=zzz-nothing",
      "status=INACTIVE&sort=name:desc",
    ])("lists what the list lists for ?%s, with the same email and status", async (query) => {
      const joiner = query ? "&" : "";

      const list = await getJson(`/${path}?limit=1000${joiner}${query}`);
      const rows = tableOf(await sheetOf(await download(`/${path}/export?format=xlsx${joiner}${query}`)));

      expect(rows.map((row) => row["Name"])).toEqual(list.body.data.map((c: { name: string }) => c.name));
      expect(rows.map((row) => row["Email"])).toEqual(
        list.body.data.map((c: { email: string | null }) => c.email),
      );
      expect(rows.map((row) => row["Status"])).toEqual(
        list.body.data.map((c: { status: string }) => (c.status === "ACTIVE" ? "Active" : "Inactive")),
      );
    });

    it("exports inactive records too, unless a status filter leaves them out", async () => {
      const all = tableOf(await sheetOf(await download(`/${path}/export?format=xlsx`)));
      const activeOnly = tableOf(await sheetOf(await download(`/${path}/export?format=xlsx&status=ACTIVE`)));

      expect(all.filter((row) => row["Status"] === "Inactive").length).toBeGreaterThanOrEqual(2);
      expect(activeOnly.map((row) => row["Status"])).not.toContain("Inactive");
    });

    it("shows a record without an email as an empty cell", async () => {
      const rows = tableOf(await sheetOf(await download(`/${path}/export?format=xlsx&search=nomail`)));

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ Name: "Xena Nomail", Email: null, Status: "Inactive" });
    });

    it("keeps the English words in the pdf, whatever the language, and lists the status filter", async () => {
      const res = await download(`/${path}/export?format=pdf&status=INACTIVE`, admin, "ar");

      expect(res.status).toBe(200);
      const text = JSON.stringify(await readPdf(res.body));
      expect(text).toContain("Inactive");
      expect(text).toContain("yara@other.test");
      expect(text).toContain("Status: Inactive");
    });

    it("refuses an unknown status filter with 400, as the list does", async () => {
      const exported = await download(`/${path}/export?format=xlsx&status=PAUSED`);
      const listed = await getJson(`/${path}?status=PAUSED`);

      expect(exported.status).toBe(400);
      expect(listed.status).toBe(400);
      expect(JSON.parse(exported.body.toString()).details).toEqual(listed.body.details);
    });

    it("records the status filter in the export audit row, never the data", async () => {
      await download(`/${path}/export?format=xlsx&status=INACTIVE`);

      expect(exportAudits()).toHaveLength(1);
      expect(exportAudits()[0]).toMatchObject({ after: { filters: { status: "INACTIVE" }, rowCount: 2 } });
      expect(JSON.stringify(exportAudits())).not.toContain("yara@other.test");
    });
  });

  describe("audit log", () => {
    beforeEach(() => {
      addAuditRow({
        action: "villa.create",
        entity: "Villa",
        entityId: "p1",
        actorId: admin.id,
        createdAt: new Date("2026-03-04T05:06:00Z"),
        ip: "203.0.113.5",
        userAgent: "Mozilla/5.0",
        requestId: "req-1",
        before: { secret: "before-value" },
        after: { secret: "after-value" },
      });
      addAuditRow({ action: "auth.login", entity: "User", createdAt: new Date("2026-03-05T05:06:00Z") });
      addAuditRow({
        action: "villa.update",
        entity: "Villa",
        createdAt: new Date("2026-03-06T05:06:00Z"),
      });
    });

    it.each(["", "entity=Villa", "action=auth.login", "search=villa", "sort=createdAt", "from=2026-03-05"])(
      "export for ?%s lists what /audit-logs lists",
      async (query) => {
        const joiner = query ? "&" : "";

        const list = await getJson(`/audit-logs?limit=1000${joiner}${query}`);
        const rows = tableOf(
          await sheetOf(await download(`/audit-logs/export?format=xlsx${joiner}${query}`)),
        );

        // The same entries in the same order; the export reads each action as the words the list shows in English.
        expect(rows.map((row) => row["Action"])).toEqual(
          list.body.data.map((r: { actionLabel: string }) => r.actionLabel),
        );
        expect(rows.map((row) => row["Entity"])).toEqual(
          list.body.data.map((r: { entity: string }) => r.entity),
        );
      },
    );

    it("has the audit columns and never the before and after snapshots", async () => {
      const res = await download("/audit-logs/export?format=xlsx&entity=Villa&action=villa.create");
      const sheet = await sheetOf(res);

      const titles = (sheet.getRow(1).values as string[]).slice(1);
      expect(titles).toEqual([
        "Time (UTC)",
        "Actor",
        "Actor Email",
        "Action",
        "Entity",
        "Entity ID",
        "IP",
        "User Agent",
        "Request ID",
      ]);
      const [row] = tableOf(sheet);
      expect(row).toMatchObject({
        Actor: "Root Admin",
        "Actor Email": "root@example.test",
        Action: "Created a villa",
        Entity: "Villa",
        "Entity ID": "p1",
        IP: "203.0.113.5",
        "User Agent": "Mozilla/5.0",
        "Request ID": "req-1",
      });
      expect(row!["Time (UTC)"]).toEqual(new Date("2026-03-04T05:06:00Z"));
      expect(JSON.stringify(res.body.toString("latin1"))).not.toContain("before-value");
      const text = JSON.stringify(tableOf(sheet));
      expect(text).not.toContain("before-value");
      expect(text).not.toContain("after-value");
    });

    it("shows the action and the entity as English words, with no entity name column, whatever the request language", async () => {
      addAuditRow({
        action: "civil_engineer.create",
        entity: "CivilEngineer",
        entityId: "e1",
        createdAt: new Date("2026-03-07T05:06:00Z"),
      });
      addAuditRow({
        action: "contractor.create",
        entity: "Contractor",
        entityId: "c1",
        createdAt: new Date("2026-03-08T05:06:00Z"),
      });

      const sheet = await sheetOf(
        await download("/audit-logs/export?format=xlsx&entity=CivilEngineer", admin, "ar"),
      );
      const all = tableOf(await sheetOf(await download("/audit-logs/export?format=xlsx", admin, "ar")));
      const pdf = (await readPdf((await download("/audit-logs/export?format=pdf", admin, "ar")).body)).pages
        .flat()
        .join(" ");

      expect(tableOf(sheet).map((row) => [row["Action"], row["Entity"]])).toEqual([
        ["Created a civil engineer", "Civil engineer"],
      ]);
      expect(all.map((row) => row["Entity"])).toEqual(
        expect.arrayContaining(["Civil engineer", "Contractor", "Villa", "User"]),
      );
      expect(all.map((row) => row["Action"])).toEqual(
        expect.arrayContaining(["Created a contractor", "Created a villa", "Signed in"]),
      );
      expect(JSON.stringify(all)).not.toMatch(/[؀-ۿ]/);
      expect(JSON.stringify(all)).not.toMatch(/CivilEngineer|civil_engineer.create/);
      expect(pdf).toContain("Created a civil engineer");
      expect(pdf).not.toMatch(/[؀-ۿ]/);
      expect(Object.keys(all[0] ?? {})).not.toContain("Entity Name");
    });

    it("shows System for an entry without an actor", async () => {
      const rows = tableOf(await sheetOf(await download("/audit-logs/export?format=xlsx&action=auth.login")));

      expect(rows[0]!["Actor"]).toBe("System");
    });
  });

  describe("contractor summary", () => {
    function seedSummary() {
      for (const [number, area, startDate] of [
        ["S-001", "New Cairo", day("2026-01-05")],
        ["S-002", "New Cairo", null],
        ["S-003", "Sheikh Zayed", null],
        ["S-004", "6 October", null],
        ["S-005", "6 October", null],
        ["S-006", "6 October", null],
      ] as const) {
        const villa = addContractorVilla({ villaNumber: number, area, startDate });
        linkVilla(conA.id, villa.id);
      }
      const other = addContractorVilla({ villaNumber: "S-900" });
      linkVilla(conB.id, other.id);
    }

    it("has the contractor header and the villa count above the table, then the villas", async () => {
      seedSummary();

      const sheet = await sheetOf(await download(`/contractors/${conA.id}/summary/export?format=xlsx`));

      const preamble = Object.fromEntries(
        [1, 2, 3].map((n) => [sheet.getRow(n).getCell(1).value, sheet.getRow(n).getCell(2).value]),
      );
      expect(preamble).toEqual({
        Contractor: "Nile Builders",
        Phone: "0102 000 0001",
        "Total villas": "6",
      });
      expect((sheet.getRow(5).values as string[]).slice(1)).toEqual([
        "Villa Number",
        "Area",
        "Block",
        "Plot",
        "Start Date",
        "Target Date",
      ]);
      const rows = tableOf(sheet, 5);
      expect(rows.map((row) => row["Villa Number"])).toEqual([
        "S-001",
        "S-002",
        "S-003",
        "S-004",
        "S-005",
        "S-006",
      ]);
      expect(rows[0]!["Start Date"]).toEqual(day("2026-01-05"));
      expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 5 });
    });

    it("lists only this contractor's villas", async () => {
      seedSummary();

      const rows = tableOf(
        await sheetOf(await download(`/contractors/${conB.id}/summary/export?format=xlsx`)),
        5,
      );

      expect(rows.map((row) => row["Villa Number"])).toEqual(["S-900"]);
    });

    it("matches the summary endpoint for the same query", async () => {
      seedSummary();
      for (const query of ["", "sort=villaNumber:desc", "sort=startDate", "sort=targetDate:desc"]) {
        const joiner = query ? "&" : "";
        const list = await getJson(`/contractors/${conA.id}/summary?limit=1000${joiner}${query}`);
        const rows = tableOf(
          await sheetOf(
            await download(`/contractors/${conA.id}/summary/export?format=xlsx${joiner}${query}`),
          ),
          5,
        );

        expect(
          rows.map((row) => row["Villa Number"]),
          query,
        ).toEqual(list.body.data.villas.map((p: { villaNumber: string }) => p.villaNumber));
      }
    });

    it("the pdf shows the header, the villa count and the villas", async () => {
      seedSummary();

      const res = await download(`/contractors/${conA.id}/summary/export?format=pdf&sort=villaNumber:desc`);

      const text = (await readPdf(res.body)).pages.flat().join(" ");
      expect(text).toContain("Contractor Summary");
      expect(text).toContain("Nile Builders");
      expect(text).toContain("Total villas:");
      expect(text).toContain("Sort: villaNumber desc");
      expect(text).toContain("S-001");
      expect(text).not.toContain("S-900");
    });

    it("answers 404 CONTRACTOR_NOT_FOUND for an unknown contractor, in Arabic, with no audit row", async () => {
      const res = await download(`/contractors/${MISSING_ID}/summary/export?format=xlsx`, admin, "ar");

      expect(res.status).toBe(404);
      expect(JSON.parse(res.body.toString())).toMatchObject({ code: "CONTRACTOR_NOT_FOUND" });
      expect(exportAudits()).toHaveLength(0);
    });
  });
});

describe("English output, whatever the request language", () => {
  it("villas: English headers, ISO dates, even with Accept-Language: ar", async () => {
    seedVillas();

    const res = await download("/villas/export?format=xlsx&sort=villaNumber", admin, "ar");
    const sheet = await sheetOf(res);

    expect((sheet.getRow(1).values as string[]).slice(1)).toEqual([
      "Villa Number",
      "Owner Name",
      "Area",
      "Block",
      "Plot",
      "Contractor",
      "Electrical Engineer",
      "Civil Engineer",
      "Start Date",
      "Target Date",
      "Budget",
      "Currency",
      "Progress",
      "Created (UTC)",
    ]);
    expect(res.headers["content-language"]).toBe("en");
    expect(sheet.getRow(2).getCell(9).numFmt).toBe("yyyy-mm-dd");
    expect(sheet.getRow(2).getCell(14).numFmt).toBe('yyyy-mm-dd hh:mm "UTC"');
    expect(sheet.name).toBe("Villas");
  });

  it("the pdf text is English too, with Arabic only where it is stored data", async () => {
    seedVillas();

    const res = await download("/villas/export?format=pdf&sort=villaNumber&block=B3", admin, "ar");

    const text = (await readPdf(res.body)).pages.flat().join(" ");
    expect(text).toContain("Villas");
    expect(text).toContain("Generated:");
    expect(text).toContain("Filters:");
    expect(text).toContain("Block: B3");
    expect(text).toContain("Page 1 of 1");
    expect(text).toContain("القاهرة الجديدة");
    expect(text).toContain("منى حسن");
    expect(text).not.toMatch(/صفحة|تم الإنشاء|الحالة/);
  });

  it("shows the applied filters on the pdf, ids included", async () => {
    seedVillas();

    const res = await download(
      `/villas/export?format=pdf&search=cairo&civilEngineerId=${eng1.id}&startFrom=2026-01-01&sort=villaNumber:desc`,
    );

    const text = (await readPdf(res.body)).pages.flat().join(" ");
    expect(text).toContain("Search: cairo");
    expect(text).toContain(`Civil engineer ID: ${eng1.id}`);
    expect(text).toContain("Start from: 2026-01-01");
    expect(text).toContain("Sort: villaNumber desc");
  });

  it("an empty result is a valid file in both formats", async () => {
    const xlsx = await sheetOf(await download("/villas/export?format=xlsx"));
    const pdf = await readPdf((await download("/villas/export?format=pdf")).body);

    expect(xlsx.rowCount).toBe(1);
    expect(pdf.pages.flat().join(" ")).toContain("No records");
  });

  it("Arabic names are written as they are in the workbook", async () => {
    seedVillas();

    const rows = tableOf(await sheetOf(await download("/villas/export?format=xlsx&sort=villaNumber")));

    expect(rows[3]!["Area"]).toBe("القاهرة الجديدة");
    expect(rows[3]!["Civil Engineer"]).toBe("منى حسن");
    expect(rows[3]!["Contractor"]).toBe("شركة النيل");
  });
});

describe("the row cap", () => {
  // Civil engineers stand in for a big table: their in-memory list is cheap, so 10,000 rows stay quick.
  // The cap is the same code for every export, and the service tests check it for all seven.
  const fill = (count: number) => {
    for (let i = 0; i < count; i++) {
      addVilla({
        villaNumber: `X-${String(i).padStart(5, "0")}`,
        plot: String(i),
        civilEngineerId: eng1.id,
      });
    }
  };
  const fillEngineers = (count: number, name = (i: number) => `Alpha ${String(i).padStart(5, "0")}`) => {
    for (let i = 0; i < count; i++) addEngineer({ name: name(i) });
  };

  it("refuses more than 10,000 rows with 422 EXPORT_TOO_LARGE, in Arabic, before generating anything", async () => {
    fillEngineers(10_001);

    const res = await download("/civil-engineers/export?format=xlsx", admin, "ar");

    const body = JSON.parse(res.body.toString());
    expect(res.status).toBe(422);
    expect(body).toMatchObject({
      code: "EXPORT_TOO_LARGE",
      message: "يحتوي هذا التصدير على أكثر من 10,000 سجل. قلّل نطاق الفلاتر وحاول مرة أخرى",
    });
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(exportAudits()).toHaveLength(0);
  });

  it("refuses a pdf the same way, and answers in English when asked in English", async () => {
    fillEngineers(10_001);

    const res = await download("/civil-engineers/export?format=pdf", admin, "en");

    expect(res.status).toBe(422);
    expect(JSON.parse(res.body.toString())).toMatchObject({
      code: "EXPORT_TOO_LARGE",
      message: "This export has more than 10,000 records. Narrow the filters and try again",
    });
  });

  it("allows exactly 10,000 rows, and the file has all of them", async () => {
    // The two engineers made for every test count too.
    fillEngineers(10_000 - engineerTables.engineers.length);

    const res = await download("/civil-engineers/export?format=xlsx&sort=name");
    const sheet = await sheetOf(res);

    expect(sheet.rowCount).toBe(10_001);
    expect(sheet.getRow(2).getCell(1).value).toBe("Alpha 00000");
    expect(sheet.getRow(10_001).getCell(1).value).toBe("منى حسن");
    expect(exportAudits()[0]).toMatchObject({ after: { rowCount: 10_000 } });
  });

  it("is decided by the matching rows, so a filter brings a big table under the cap", async () => {
    fillEngineers(10_001, (i) => `${i % 2 === 0 ? "Alpha" : "Beta"} ${String(i).padStart(5, "0")}`);

    const res = await download("/civil-engineers/export?format=xlsx&search=Beta");

    expect(res.status).toBe(200);
    expect((await sheetOf(res)).rowCount).toBe(5001);
  });

  it("a large pdf is generated and has every row", async () => {
    fill(900);

    const res = await download("/villas/export?format=pdf&sort=villaNumber");

    const { numPages, pages } = await readPdf(res.body);
    expect(numPages).toBeGreaterThan(20);
    expect(
      pages
        .flat()
        .join(" ")
        .match(/X-\d{5}/g),
    ).toHaveLength(900);
    expect(pages[numPages - 1]!.join(" ")).toContain(`Page ${numPages} of ${numPages}`);
  });

  it("reads a big export in several pages of the list, each once", async () => {
    fill(2_500);
    const listVillas = vi.spyOn(InMemoryVillasRepository.prototype, "list");

    const res = await download("/villas/export?format=xlsx&sort=villaNumber");

    expect((await sheetOf(res)).rowCount).toBe(2_501);
    expect(listVillas.mock.calls.map((call) => [call[0].skip, call[0].take])).toEqual([
      [0, 1000],
      [1000, 1000],
      [2000, 1000],
    ]);
  });
});

describe("the audit entry", () => {
  it.each(endpoints)(
    "%s: one row, action %s, with the filters, format and row count",
    async (_name, path, _perm, action, entity) => {
      seedVillas();
      addAuditRow({ action: "villa.create", entity: "Villa" });
      const before = auditRows().length;

      const res = await download(`${path()}?format=pdf`);

      expect(res.status).toBe(200);
      const added = auditRows().slice(before);
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ actorId: admin.id, action, entity });
      expect(added[0]!["after"]).toMatchObject({
        format: "pdf",
        rowCount: expect.any(Number),
        filters: expect.any(Object),
      });
    },
  );

  it("records the filters that were applied (not paging), the format and the count", async () => {
    seedVillas();

    await download("/villas/export?format=xlsx&area=new%20cairo&block=B1&sort=villaNumber:desc");

    expect(exportAudits()).toHaveLength(1);
    expect(exportAudits()[0]).toMatchObject({
      action: "export.villas",
      entity: "Villa",
      after: {
        format: "xlsx",
        rowCount: 1,
        filters: { area: "new cairo", block: "B1", sort: "villaNumber:desc" },
      },
    });
    expect(Object.keys((exportAudits()[0]!["after"] as { filters: object }).filters)).not.toContain("page");
    expect(Object.keys((exportAudits()[0]!["after"] as { filters: object }).filters)).not.toContain("limit");
  });

  it("records no data rows", async () => {
    seedVillas();

    await download("/villas/export?format=xlsx");

    const serialized = JSON.stringify(exportAudits());
    expect(serialized).not.toContain("P-001");
    expect(serialized).not.toContain("Nile");
    expect(serialized).not.toContain("Mona");
  });

  it("the contractor summary entry names the contractor", async () => {
    await download(`/contractors/${conA.id}/summary/export?format=xlsx&sort=villaNumber:desc`);

    expect(exportAudits()[0]).toMatchObject({
      action: "export.contractor-summary",
      entity: "Contractor",
      entityId: conA.id,
      after: { format: "xlsx", filters: { sort: "villaNumber:desc" } },
    });
  });

  it("records the actor and the request details", async () => {
    const user = employee("x@example.test", "villas:export");

    await request(app)
      .get("/api/v1/villas/export?format=xlsx")
      .set(await as(user))
      .set("User-Agent", "export-test");

    expect(exportAudits()[0]).toMatchObject({ actorId: user.id, userAgent: "export-test" });
    expect(exportAudits()[0]!["requestId"]).toEqual(expect.any(String));
  });

  it("is written before the file: when the audit write fails nothing is sent", async () => {
    seedVillas();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await download("/villas/export?format=xlsx");

    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(JSON.parse(res.body.toString()).code).toBe("INTERNAL_ERROR");
  });

  it("a refused export (too many rows, bad format, bad id) writes no row", async () => {
    await download("/villas/export?format=bogus");
    await download(`/contractors/${MISSING_ID}/summary/export?format=xlsx`);
    await download("/villas/export?format=xlsx&limit=5");

    expect(exportAudits()).toHaveLength(0);
  });
});

describe("route order: /export is not read as an id", () => {
  it.each([
    ["/villas/export", "villas:export"],
    ["/contractors/export", "contractors:read"],
    ["/civil-engineers/export", "civil-engineers:read"],
    ["/electrical-engineers/export", "electrical-engineers:read"],
    ["/areas/export", "areas:read"],
    ["/audit-logs/export", "audit:read"],
  ])("%s is the export for someone who has only its permission", async (path, permission) => {
    const res = await download(`${path}?format=xlsx`, employee(`${permission}@example.test`, permission));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
  });

  it("the modules' own :id routes still work and still need their own permissions", async () => {
    const { p1 } = seedVillas();
    const exporter = employee("x@example.test", "villas:export", "contractors:read", "audit:read");

    expect((await getJson(`/villas/${p1.id}`, exporter)).status).toBe(403);
    expect((await getJson(`/villas/${p1.id}`)).status).toBe(200);
    expect((await getJson(`/contractors/${conA.id}`, exporter)).status).toBe(200);
    expect((await getJson(`/contractors/${conA.id}/summary`)).status).toBe(200);
    expect((await getJson(`/audit-logs/${MISSING_ID}`)).status).toBe(404);
  });

  it("without the export route, the old behaviour would have been a 400 or 403: it is not", async () => {
    const res = await download("/villas/export?format=xlsx", employee("x@example.test", "villas:export"));

    expect(res.status).not.toBe(400);
    expect(res.status).not.toBe(403);
  });
});

describe("rate limit", () => {
  it("answers 429 once a user has used the allowance for the window, in Arabic", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 2;
    const user = employee("limited@example.test", "villas:export");

    const first = await download("/villas/export?format=xlsx", user);
    const second = await download("/villas/export?format=pdf", user);
    const third = await download("/villas/export?format=xlsx", user, "ar");

    expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
    expect(JSON.parse(third.body.toString())).toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });

  it("counts each user separately, even from the same address", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 1;
    const a = employee("a@example.test", "villas:export");
    const b = employee("b@example.test", "villas:export");

    expect((await download("/villas/export?format=xlsx", a)).status).toBe(200);
    expect((await download("/villas/export?format=xlsx", a)).status).toBe(429);
    expect((await download("/villas/export?format=xlsx", b)).status).toBe(200);
  });

  it("is shared by all the export routes", async () => {
    env.EXPORT_RATE_LIMIT_MAX = 2;
    const user = employee("all@example.test", "villas:export", "contractors:read", "audit:read");

    expect((await download("/villas/export?format=xlsx", user)).status).toBe(200);
    expect((await download("/contractors/export?format=xlsx", user)).status).toBe(200);
    expect((await download("/audit-logs/export?format=xlsx", user)).status).toBe(429);
  });

  it("follows the limit in the environment", async () => {
    const user = employee("env@example.test", "villas:export");
    env.EXPORT_RATE_LIMIT_MAX = 100;

    for (let i = 0; i < 5; i++) {
      expect((await download("/villas/export?format=xlsx", user)).status).toBe(200);
    }
  });
});

describe("a client that disconnects during the download", () => {
  it("is not an error: nothing is logged as a failure, and the server carries on", async () => {
    // A workbook is sent as it is made (a PDF only once it is complete), so it can be cut off part way.
    for (let i = 0; i < 9_000; i++) addEngineer({ name: `Disconnect ${String(i).padStart(5, "0")}` });
    const failure = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const server = app.listen(0);
    await once(server, "listening");
    try {
      const header = await as(admin);
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            port: (server.address() as AddressInfo).port,
            path: "/api/v1/civil-engineers/export?format=xlsx",
            headers: header,
          },
          (res) => {
            res.once("data", () => {
              res.destroy();
              req.destroy();
              resolve();
            });
          },
        );
        req.on("error", () => undefined);
        req.end();
      });
      await new Promise((resolve) => setTimeout(resolve, 800));
    } finally {
      server.close();
    }

    expect(failure).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.anything(), "the client disconnected during an export");
    expect((await download("/civil-engineers/export?format=xlsx&search=Disconnect 00001")).status).toBe(200);
  });
});

describe("a failure while the file is being written", () => {
  const seed = () => {
    for (let i = 0; i < 1_500; i++) {
      addVilla({
        villaNumber: `Y-${String(i).padStart(5, "0")}`,
        plot: String(i),
        civilEngineerId: eng1.id,
      });
    }
  };

  it("a failure on a later page is an ordinary error response: columns are fitted to every row, so nothing is sent before they are all read", async () => {
    seed();
    const original = InMemoryVillasRepository.prototype.list;
    let calls = 0;
    vi.spyOn(InMemoryVillasRepository.prototype, "list").mockImplementation(function (
      this: unknown,
      ...args
    ) {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("database went away"));
      return original.apply(this as InMemoryVillasRepository, args);
    });
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await download("/villas/export?format=xlsx&sort=villaNumber");

    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    const next = await download("/villas/export?format=xlsx&status=OPEN&search=Y-00001");
    expect(next.status).toBe(200);
  });

  it("ends the connection instead of sending a short file that looks complete, and the server carries on", async () => {
    seed();
    const commit = vi
      .spyOn(ExcelJS.stream.xlsx.WorkbookWriter.prototype, "commit")
      .mockRejectedValueOnce(new Error("disk went away"));
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(download("/villas/export?format=xlsx&sort=villaNumber")).rejects.toBeDefined();

    expect(commit).toHaveBeenCalled();
    expect(exportAudits()).toHaveLength(1);
    const next = await download("/villas/export?format=xlsx&status=OPEN&search=Y-00001");
    expect(next.status).toBe(200);
  });

  it("a failure on the very first page is an ordinary error response", async () => {
    vi.spyOn(InMemoryVillasRepository.prototype, "list").mockRejectedValue(new Error("database went away"));
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await download("/villas/export?format=xlsx");

    expect(res.status).toBe(500);
    expect(res.headers["content-disposition"]).toBeUndefined();
    expect(exportAudits()).toHaveLength(0);
  });
});
