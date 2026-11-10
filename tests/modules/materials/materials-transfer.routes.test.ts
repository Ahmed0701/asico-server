import { randomUUID } from "node:crypto";
import type http from "node:http";
import ExcelJS from "exceljs";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { importBatchTable } from "../imports/in-memory-import-batch.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { workbookOf } from "../../shared/import/xlsx-fixtures.js";
import { addDelivery, addFactory, addItem } from "./in-memory-materials.repository.js";
import { materialTables } from "./material-tables.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/core/imports/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/imports/repository.js")>()),
  ImportBatchRepository: (await import("../imports/in-memory-import-batch.repository.js"))
    .InMemoryImportBatchRepository,
}));
vi.mock("../../../src/modules/materials/repository/deliveries.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/materials/repository/deliveries.repository.js")
  >()),
  DeliveriesRepository: (await import("./in-memory-materials.repository.js")).InMemoryDeliveriesRepository,
}));
vi.mock("../../../src/modules/materials/repository/balance.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/materials/repository/balance.repository.js")>()),
  BalanceRepository: (await import("./in-memory-materials.repository.js")).InMemoryBalanceRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const HEADER = ["Villa Number", "Factory", "Material", "Quantity", "Delivery Date", "Delivery Note No."];

let admin: User;
beforeEach(() => {
  store.reset();
  villaTables.reset();
  materialTables.reset();
  idempotencyTable.reset();
  importBatchTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});
const employee = (email: string, ...codes: string[]): User => {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
};
const binary = (response: request.Response, done: (err: Error | null, body: Buffer) => void): void => {
  const incoming = response as unknown as http.IncomingMessage;
  const chunks: Buffer[] = [];
  incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
  incoming.on("end", () => done(null, Buffer.concat(chunks)));
};
const download = async (path: string, user: User = admin) =>
  request(app)
    .get(`/api/v1${path}`)
    .set(await as(user))
    .buffer(true)
    .parse(binary as never);
async function tableOf(res: request.Response): Promise<Record<string, ExcelJS.CellValue>[]> {
  expect(res.status).toBe(200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(res.body as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0]!;
  // A summary can stand above the table: the table starts at the row of its first header.
  let head = 1;
  while (head <= sheet.rowCount && sheet.getRow(head).getCell(1).value !== "Villa Number") head++;
  const titles = (sheet.getRow(head).values as ExcelJS.CellValue[]).slice(1) as string[];
  const rows: Record<string, ExcelJS.CellValue>[] = [];
  for (let n = head + 1; n <= sheet.rowCount; n++) {
    const values = (sheet.getRow(n).values as ExcelJS.CellValue[]).slice(1);
    rows.push(Object.fromEntries(titles.map((title, i) => [title, values[i] ?? null])));
  }
  return rows;
}
const upload = async (file: Buffer, query = "", user: User = admin) =>
  request(app)
    .post(`/api/v1/material-deliveries/import${query}`)
    .set(await as(user))
    .set("Idempotency-Key", `key-${randomUUID()}`)
    .attach("file", file, {
      filename: "materials.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
const auditActions = () => (store.auditRows as unknown as { action: string }[]).map((row) => row.action);

// Two villas, a factory of each type, and materials of each type.
function seed() {
  const v1 = addVilla({ villaNumber: "V-101" });
  const v2 = addVilla({ villaNumber: "V-202" });
  const gulf = addFactory({ name: "Gulf Switchgear", type: "SWITCHGEAR" });
  const kc = addFactory({ name: "Kuwait Cables", type: "CABLE" });
  const msb = addItem({ name: "MSB Box", requiredPerVilla: 1 });
  const db = addItem({ name: "DB Interior", requiredPerVilla: 3 });
  const cable = addItem({ name: "Cable 4x16", type: "CABLE", unit: "m", requiredPerVilla: 0 });
  return { v1, v2, gulf, kc, msb, db, cable };
}

describe("access control", () => {
  it.each([
    ["/material-deliveries/export?format=xlsx", "materials:read"],
    ["/material-balance/export?format=pdf", "materials:read"],
    ["/material-deliveries/import/template", "materials:create"],
  ])("GET %s needs %s", async (path, needed) => {
    const others = ["materials:read", "materials:create", "materials:update", "materials:delete"].filter(
      (code) => code !== needed,
    );
    expect((await request(app).get(`/api/v1${path}`)).status).toBe(401);
    expect((await download(path, employee("o@example.test", ...others))).status).toBe(403);
    expect((await download(path, employee("n@example.test", needed))).status).toBe(200);
  });

  it("the upload needs materials:create and an Idempotency-Key", async () => {
    const file = await workbookOf([HEADER]);
    const reader = employee("r@example.test", "materials:read", "materials:update");
    expect((await upload(file, "", reader)).status).toBe(403);
    const noKey = await request(app)
      .post("/api/v1/material-deliveries/import")
      .set(await as(admin))
      .attach("file", file, "m.xlsx");
    expect(noKey.status).toBe(400);
  });
});

describe("GET /material-deliveries/export", () => {
  it("writes one row per material with the full delivery, its type, unit and delivery note files", async () => {
    const { v1, gulf, msb, db } = seed();
    addDelivery({
      villaId: v1.id,
      factoryId: gulf.id,
      noteNumber: "DN-7",
      deliveryDate: new Date("2026-11-01T00:00:00.000Z"),
      lines: [
        { itemId: msb.id, quantity: 1 },
        { itemId: db.id, quantity: 2.5 },
      ],
      notes: [
        { id: "n1", key: "k", name: "dn7.pdf", mime: "application/pdf", size: 1, uploadedAt: new Date() },
      ],
    });

    const res = await download("/material-deliveries/export?format=xlsx");
    const rows = await tableOf(res);

    expect(res.headers["content-disposition"]).toMatch(
      /^attachment; filename="asico-material-deliveries-\d{4}-\d{2}-\d{2}\.xlsx"$/,
    );
    expect(Object.keys(rows[0]!)).toEqual([
      ...HEADER,
      "Type",
      "Unit",
      "Delivery Note Files",
      "Created (UTC)",
    ]);
    expect(
      rows.map((r) => [
        r["Villa Number"],
        r["Material"],
        r["Quantity"],
        r["Type"],
        r["Unit"],
        r["Delivery Note Files"],
      ]),
    ).toEqual([
      ["V-101", "MSB Box", 1, "Switchgears", "pcs", "dn7.pdf"],
      ["V-101", "DB Interior", 2.5, "Switchgears", "pcs", "dn7.pdf"],
    ]);
    expect(rows[0]!["Delivery Date"]).toEqual(new Date("2026-11-01T00:00:00.000Z"));
    expect(auditActions()).toEqual(["export.material-deliveries"]);
  });

  it("exports what the list filters keep, as a PDF too, and refuses a bad format", async () => {
    const { v1, gulf, kc, msb, cable } = seed();
    addDelivery({ villaId: v1.id, factoryId: gulf.id, lines: [{ itemId: msb.id, quantity: 1 }] });
    addDelivery({ villaId: v1.id, factoryId: kc.id, lines: [{ itemId: cable.id, quantity: 100 }] });

    const cables = await tableOf(await download("/material-deliveries/export?format=xlsx&type=CABLE"));
    const pdf = await download("/material-deliveries/export?format=pdf");

    expect(cables.map((r) => r["Material"])).toEqual(["Cable 4x16"]);
    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await download("/material-deliveries/export?format=csv")).status).toBe(400);
  });
});

describe("GET /material-balance/export", () => {
  it("writes the balance of every villa, filtered to what is not delivered", async () => {
    const { v1, gulf, msb } = seed();
    addDelivery({ villaId: v1.id, factoryId: gulf.id, lines: [{ itemId: msb.id, quantity: 1 }] });

    const rows = await tableOf(await download("/material-balance/export?format=xlsx&status=PENDING"));

    expect(
      rows.map((r) => [
        r["Villa Number"],
        r["Material"],
        r["Required"],
        r["Delivered"],
        r["Balance"],
        r["Status"],
      ]),
    ).toEqual([
      ["V-101", "DB Interior", 3, 0, 3, "Not delivered"],
      ["V-202", "MSB Box", 1, 0, 1, "Not delivered"],
      ["V-202", "DB Interior", 3, 0, 3, "Not delivered"],
    ]);
    expect(auditActions()).toEqual(["export.material-balance"]);
  });
});

describe("the import", () => {
  it("offers a template with the six columns", async () => {
    seed();
    const res = await download("/material-deliveries/import/template");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.body as unknown as ArrayBuffer);

    expect(res.headers["content-disposition"]).toBe(
      'attachment; filename="material-deliveries-import-template.xlsx"',
    );
    expect((workbook.worksheets[0]!.getRow(1).values as string[]).slice(1)).toEqual(HEADER);
  });

  it("makes one delivery of the rows with the same villa, factory, date and note number, and adds up a material twice", async () => {
    const { v1, msb } = seed();
    const file = await workbookOf([
      HEADER,
      ["V-101", "Gulf Switchgear", "MSB Box", 1, "2026-11-05", "DN-1"],
      ["V-101", "gulf switchgear", "db interior", 2, "2026-11-05", "DN-1"],
      ["V-101", "Gulf Switchgear", "DB Interior", 1, "2026-11-05", "DN-1"],
      ["V-202", "Kuwait Cables", "Cable 4x16", 150.5, "2026-11-06", null],
    ]);

    const res = await upload(file);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ ok: true, total: 4, imported: 4 });
    expect(materialTables.deliveries).toHaveLength(2);
    const first = materialTables.deliveries.find((d) => d.villaId === v1.id)!;
    expect(first.noteNumber).toBe("DN-1");
    expect(first.lines.map((l) => [l.itemId === msb.id ? "MSB Box" : "DB Interior", l.quantity])).toEqual([
      ["MSB Box", 1],
      ["DB Interior", 3],
    ]);
    expect(auditActions()).toContain("material_delivery.import");
  });

  it("checks every row and saves nothing when one is wrong: villa, factory, material, type and quantity", async () => {
    seed();
    const file = await workbookOf([
      HEADER,
      ["V-999", "Gulf Switchgear", "MSB Box", 1, "2026-11-05", null],
      ["V-101", "No Such Factory", "MSB Box", 1, "2026-11-05", null],
      ["V-101", "Gulf Switchgear", "Unknown", 1, "2026-11-05", null],
      ["V-101", "Gulf Switchgear", "Cable 4x16", 1, "2026-11-05", null],
      ["V-101", "Gulf Switchgear", "MSB Box", 0, "2026-11-05", null],
    ]);

    const res = await upload(file);
    const errors = (res.body.data.errors as { row: number; column: string; code: string }[]).map((e) => [
      e.row,
      e.column,
      e.code,
    ]);

    expect(res.status).toBe(422);
    expect(errors).toEqual([
      [2, "Villa Number", "REFERENCE_NOT_FOUND"],
      [3, "Factory", "REFERENCE_NOT_FOUND"],
      [4, "Material", "REFERENCE_NOT_FOUND"],
      [5, "Material", "INVALID_VALUE"],
      [6, "Quantity", "INVALID_VALUE"],
    ]);
    expect(materialTables.deliveries).toHaveLength(0);
  });

  it("a dry run checks the file and saves nothing; an exported file imports again", async () => {
    const { v1, gulf, msb } = seed();
    addDelivery({
      villaId: v1.id,
      factoryId: gulf.id,
      noteNumber: "DN-9",
      deliveryDate: new Date("2026-11-02T00:00:00.000Z"),
      lines: [{ itemId: msb.id, quantity: 2 }],
    });
    const exported = (await download("/material-deliveries/export?format=xlsx")).body as Buffer;
    materialTables.deliveries = [];

    const dry = await upload(exported, "?dryRun=true");
    expect(dry.status).toBe(200);
    expect(materialTables.deliveries).toHaveLength(0);

    const res = await upload(exported);
    expect(res.status).toBe(201);
    expect(materialTables.deliveries.map((d) => [d.noteNumber, d.lines[0]?.quantity])).toEqual([["DN-9", 2]]);
  });
});
