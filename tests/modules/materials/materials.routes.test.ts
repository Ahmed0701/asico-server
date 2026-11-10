import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addDelivery, addFactory, addItem } from "./in-memory-materials.repository.js";
import { materialTables } from "./material-tables.js";

// A real folder on disk for the delivery notes, made before anything is imported so the storage points at it.
const disk = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const base = mkdtempSync(joinPath(tmpdir(), "asico-notes-"));
  return { base, root: joinPath(base, "uploads") };
});

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/materials/repository/factories.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/materials/repository/factories.repository.js")
  >()),
  FactoriesRepository: (await import("./in-memory-materials.repository.js")).InMemoryFactoriesRepository,
}));
vi.mock("../../../src/modules/materials/repository/items.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/materials/repository/items.repository.js")>()),
  ItemsRepository: (await import("./in-memory-materials.repository.js")).InMemoryItemsRepository,
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
vi.mock("../../../src/core/storage/LocalDiskStorage.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/core/storage/LocalDiskStorage.js")>();
  class TestStorage extends actual.LocalDiskStorage {
    constructor() {
      super(disk.root);
    }
  }
  return { ...actual, LocalDiskStorage: TestStorage };
});

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING_ID = randomUUID();
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 1),
]);

let admin: User;
beforeEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(join(disk.root, "deliveries"), { recursive: true, force: true });
  store.reset();
  villaTables.reset();
  materialTables.reset();
  idempotencyTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(disk.base, { recursive: true, force: true });
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

type Verb = "get" | "post" | "patch" | "put" | "delete";
const call = (verb: Verb, path: string) => {
  const agent = request(app);
  return agent[verb](`/api/v1${path}`);
};
const send = async (verb: Verb, path: string, body?: object, user: User = admin) => {
  const req = call(verb, path)
    .set(await as(user))
    .set("Accept-Language", "en");
  return body === undefined ? req : req.send(body);
};
const upload = async (id: string, ...files: [Buffer, string][]) => {
  const req = call("post", `/material-deliveries/${id}/notes`).set(await as(admin));
  for (const [file, name] of files) req.attach("file", file, name);
  return req;
};
const auditActions = () => (store.auditRows as unknown as { action: string }[]).map((row) => row.action);
const storedFiles = async (): Promise<string[]> => {
  try {
    return (await readdir(join(disk.root, "deliveries"), { recursive: true })).filter((name) =>
      /\.\w+$/.test(name),
    );
  } catch {
    return [];
  }
};

// A villa, a switchgear and a cable factory, and catalog items of both types.
function seed() {
  const villa = addVilla({ villaNumber: "V-101" });
  const switchgear = addFactory({ name: "Gulf Switchgear", type: "SWITCHGEAR" });
  const cables = addFactory({ name: "Kuwait Cables", type: "CABLE" });
  const msbBox = addItem({ name: "MSB Box", sortOrder: 20 });
  const dbInterior = addItem({ name: "DB Interior", sortOrder: 50 });
  const cutOut = addItem({ name: "Cut-out Box", sortOrder: 10 });
  const cable = addItem({ name: "Cable 4x16", type: "CABLE", unit: "m", sortOrder: 10 });
  return { villa, switchgear, cables, msbBox, dbInterior, cutOut, cable };
}

const one = (itemId: string, quantity = 1) => [{ itemId, quantity }];

describe("access control", () => {
  const endpoints: [Verb, string, string][] = [
    ["get", "/factories", "materials:read"],
    ["post", "/factories", "materials:update"],
    ["patch", `/factories/${MISSING_ID}`, "materials:update"],
    ["delete", `/factories/${MISSING_ID}`, "materials:update"],
    ["get", "/material-items", "materials:read"],
    ["post", "/material-items", "materials:update"],
    ["patch", `/material-items/${MISSING_ID}`, "materials:update"],
    ["delete", `/material-items/${MISSING_ID}`, "materials:update"],
    ["get", "/material-balance", "materials:read"],
    ["put", `/villas/${MISSING_ID}/material-requirements`, "materials:update"],
    ["get", "/material-deliveries", "materials:read"],
    ["get", `/material-deliveries/${MISSING_ID}`, "materials:read"],
    ["post", "/material-deliveries", "materials:create"],
    ["patch", `/material-deliveries/${MISSING_ID}`, "materials:update"],
    ["delete", `/material-deliveries/${MISSING_ID}`, "materials:delete"],
    ["post", `/material-deliveries/${MISSING_ID}/notes`, "materials:update"],
    ["get", `/material-deliveries/${MISSING_ID}/notes/${MISSING_ID}`, "materials:read"],
    ["delete", `/material-deliveries/${MISSING_ID}/notes/${MISSING_ID}`, "materials:update"],
    ["get", `/villas/${MISSING_ID}/materials-summary`, "materials:read"],
  ];
  const allCodes = ["materials:read", "materials:create", "materials:update", "materials:delete"];

  it.each(endpoints)("%s %s requires authentication (401)", async (verb, path) => {
    expect((await call(verb, path).send({})).status).toBe(401);
  });

  it.each(endpoints)("%s %s is not opened by the other permissions", async (verb, path, needed) => {
    const others = allCodes.filter((code) => code !== needed).concat("villas:read", "villas:update");
    expect((await send(verb, path, {}, employee("e@example.test", ...others))).status).toBe(403);
  });

  it.each(endpoints)("%s %s lets through the holder of %s", async (verb, path, needed) => {
    expect([401, 403]).not.toContain((await send(verb, path, {}, employee("e@example.test", needed))).status);
  });
});

describe("factories", () => {
  it("adds factories and lists them by type and name, with their delivery count", async () => {
    const { villa, msbBox } = seed();
    const b = await send("post", "/factories", { name: "Alpha Switchgear", type: "SWITCHGEAR" });
    addDelivery({ villaId: villa.id, factoryId: b.body.data.id, lines: one(msbBox.id) });

    const all = await send("get", "/factories");

    expect(b.status).toBe(201);
    expect(all.body.data.map((f: { name: string }) => f.name)).toEqual([
      "Alpha Switchgear",
      "Gulf Switchgear",
      "Kuwait Cables",
    ]);
    expect(all.body.data[0].deliveryCount).toBe(1);
  });

  it("refuses the same name twice in one type, ignoring case, and deleting one that delivered something", async () => {
    const { villa, switchgear, msbBox } = seed();
    addDelivery({ villaId: villa.id, factoryId: switchgear.id, lines: one(msbBox.id) });

    expect(
      (await send("post", "/factories", { name: "gulf switchgear", type: "SWITCHGEAR" })).body.code,
    ).toBe("FACTORY_TAKEN");
    expect((await send("delete", `/factories/${switchgear.id}`)).body.code).toBe("FACTORY_HAS_DELIVERIES");
  });
});

describe("the catalog of materials", () => {
  it("lists by type and order, adds an item at the end of its type, and edits it", async () => {
    seed();

    const added = await send("post", "/material-items", { name: "AVA Box", type: "SWITCHGEAR" });
    const list = await send("get", "/material-items?type=SWITCHGEAR");
    const edited = await send("patch", `/material-items/${added.body.data.id}`, {
      name: "AVA Box 2",
      requiredPerVilla: 2,
    });

    expect(added.status).toBe(201);
    expect(added.body.data).toMatchObject({ unit: "pcs", sortOrder: 60, requiredPerVilla: 1, lineCount: 0 });
    expect(list.body.data.map((i: { name: string }) => i.name)).toEqual([
      "Cut-out Box",
      "MSB Box",
      "DB Interior",
      "AVA Box",
    ]);
    expect(edited.body.data).toMatchObject({ name: "AVA Box 2", requiredPerVilla: 2, version: 2 });
    expect(auditActions()).toEqual(["material_item.create", "material_item.update"]);
  });

  it("refuses a name taken in its type, and deleting or moving an item that is on a delivery", async () => {
    const { villa, switchgear, msbBox, cutOut } = seed();
    addDelivery({ villaId: villa.id, factoryId: switchgear.id, lines: one(msbBox.id) });

    expect((await send("post", "/material-items", { name: "msb box", type: "SWITCHGEAR" })).body.code).toBe(
      "MATERIAL_ITEM_TAKEN",
    );
    expect((await send("delete", `/material-items/${msbBox.id}`)).body.code).toBe("MATERIAL_ITEM_IN_USE");
    expect((await send("patch", `/material-items/${msbBox.id}`, { type: "CABLE" })).body.code).toBe(
      "MATERIAL_ITEM_IN_USE",
    );
    expect((await send("delete", `/material-items/${cutOut.id}`)).status).toBe(204);
    const negative = await send("post", "/material-items", {
      name: "X",
      type: "SWITCHGEAR",
      requiredPerVilla: -1,
    });
    expect(negative.status).toBe(400);
  });
});

describe("deliveries", () => {
  it("records a delivery with several materials, listed in catalog order", async () => {
    const { villa, switchgear, msbBox, dbInterior, cutOut } = seed();

    const res = await send("post", "/material-deliveries", {
      villaId: villa.id,
      factoryId: switchgear.id,
      lines: [
        { itemId: dbInterior.id, quantity: 3 },
        { itemId: msbBox.id, quantity: 1 },
        { itemId: cutOut.id, quantity: 1 },
      ],
      noteNumber: "DN-5521",
      deliveryDate: "2026-10-20",
    });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      villa: { villaNumber: "V-101" },
      factory: { name: "Gulf Switchgear", type: "SWITCHGEAR" },
      lines: [
        { item: { name: "Cut-out Box", unit: "pcs" }, quantity: 1 },
        { item: { name: "MSB Box", unit: "pcs" }, quantity: 1 },
        { item: { name: "DB Interior", unit: "pcs" }, quantity: 3 },
      ],
      noteNumber: "DN-5521",
      deliveryDate: "2026-10-20",
      deliveryNotes: [],
    });
    expect(auditActions()).toEqual(["material_delivery.create"]);
  });

  it("refuses no materials, the same material twice, an unknown one, and one of the other type", async () => {
    const { villa, switchgear, msbBox, cable } = seed();
    const post = (lines: unknown, villaId = villa.id) =>
      send("post", "/material-deliveries", {
        villaId,
        factoryId: switchgear.id,
        lines,
        deliveryDate: "2026-10-20",
      });

    expect((await post([])).status).toBe(400);
    expect((await post([...one(msbBox.id), ...one(msbBox.id, 2)])).status).toBe(400);
    expect((await post(one(msbBox.id, 0))).status).toBe(400);
    expect((await post(one(msbBox.id, 1.234))).status).toBe(400);
    expect((await post(one(MISSING_ID))).body.code).toBe("MATERIAL_ITEM_NOT_FOUND");
    expect((await post(one(msbBox.id), MISSING_ID)).body.code).toBe("VILLA_NOT_FOUND");
    const wrong = await post(one(cable.id, 100));
    expect(wrong.status).toBe(422);
    expect(wrong.body.code).toBe("MATERIAL_ITEM_WRONG_TYPE");
    expect(materialTables.deliveries).toHaveLength(0);
  });

  it("filters by material, type, note and search (a material name finds its deliveries)", async () => {
    const { villa, switchgear, cables, msbBox, dbInterior, cable } = seed();
    const other = addVilla({ villaNumber: "V-202" });
    addDelivery({
      villaId: villa.id,
      factoryId: switchgear.id,
      lines: one(msbBox.id),
      noteNumber: "A",
      deliveryDate: new Date("2026-10-01"),
    });
    addDelivery({
      villaId: villa.id,
      factoryId: switchgear.id,
      lines: one(dbInterior.id, 2),
      noteNumber: "B",
      deliveryDate: new Date("2026-10-03"),
      notes: [
        { id: "n1", key: "k", name: "n.pdf", mime: "application/pdf", size: 1, uploadedAt: new Date() },
      ],
    });
    addDelivery({
      villaId: other.id,
      factoryId: cables.id,
      lines: one(cable.id, 50),
      noteNumber: "C",
      deliveryDate: new Date("2026-10-05"),
    });

    const notes = async (query: string) =>
      (await send("get", `/material-deliveries${query}`)).body.data.map(
        (d: { noteNumber: string }) => d.noteNumber,
      );

    expect(await notes("")).toEqual(["C", "B", "A"]);
    expect(await notes(`?itemId=${dbInterior.id}`)).toEqual(["B"]);
    expect(await notes("?type=CABLE")).toEqual(["C"]);
    expect(await notes("?hasNote=false")).toEqual(["C", "A"]);
    expect(await notes("?search=msb")).toEqual(["A"]);
    expect(await notes("?search=v-202")).toEqual(["C"]);
    expect((await send("get", "/material-deliveries?sort=material")).status).toBe(400);
  });

  it("replaces all the lines on an edit, and checks them against a new factory", async () => {
    const { villa, switchgear, cables, msbBox, dbInterior } = seed();
    const d = addDelivery({ villaId: villa.id, factoryId: switchgear.id, lines: one(msbBox.id) });

    const edited = await send("patch", `/material-deliveries/${d.id}`, { lines: one(dbInterior.id, 4) });
    const wrongFactory = await send("patch", `/material-deliveries/${d.id}`, { factoryId: cables.id });
    const removed = await send("delete", `/material-deliveries/${d.id}`);

    expect(edited.body.data.lines).toEqual([
      { item: { id: dbInterior.id, name: "DB Interior", unit: "pcs" }, quantity: 4 },
    ]);
    expect(edited.body.data.version).toBe(2);
    expect(wrongFactory.body.code).toBe("MATERIAL_ITEM_WRONG_TYPE");
    expect(removed.status).toBe(204);
  });

  it("keeps a villa that has deliveries from being deleted", async () => {
    const { villa, switchgear, msbBox } = seed();
    addDelivery({ villaId: villa.id, factoryId: switchgear.id, lines: one(msbBox.id) });

    expect((await send("delete", `/villas/${villa.id}`)).body.code).toBe("VILLA_HAS_RECORDS");
  });
});

describe("the delivery note", () => {
  function seedDelivery() {
    const { villa, switchgear, msbBox } = seed();
    return addDelivery({ villaId: villa.id, factoryId: switchgear.id, lines: one(msbBox.id) });
  }

  it("adds several files in one upload and more later, and shows each one inline", async () => {
    const d = seedDelivery();

    const first = await upload(d.id, [PDF, "دليفري نوت.pdf"], [PNG, "page 2.PNG"]);
    const second = await upload(d.id, [PDF, "signed.pdf"]);
    const notes = second.body.data.deliveryNotes as { id: string; name: string; mimeType: string }[];
    const shown = await call("get", `/material-deliveries/${d.id}/notes/${notes[1]!.id}`).set(
      await as(admin),
    );

    expect(first.status).toBe(201);
    expect(first.body.data.deliveryNotes.map((n: { name: string }) => n.name)).toEqual([
      "دليفري نوت.pdf",
      "page 2.png",
    ]);
    expect(notes.map((n) => [n.name, n.mimeType])).toEqual([
      ["دليفري نوت.pdf", "application/pdf"],
      ["page 2.png", "image/png"],
      ["signed.pdf", "application/pdf"],
    ]);
    expect(shown.status).toBe(200);
    expect(shown.headers["content-type"]).toBe("image/png");
    expect(shown.headers["content-disposition"]).toMatch(/^inline;/);
    // In production nginx sends the file from the upload folder (development streams it, see downloadMode).
    expect(shown.headers["x-accel-redirect"]).toMatch(
      new RegExp(`^/protected-files/deliveries/${d.id}/[0-9a-f-]+\\.png$`),
    );
    expect(await storedFiles()).toHaveLength(3);
    expect(auditActions()).toEqual(["material_delivery.note_upload", "material_delivery.note_upload"]);
  });

  it("refuses the whole upload when one file is not a PDF, JPG or PNG, and keeps nothing of it", async () => {
    const d = seedDelivery();

    const res = await upload(d.id, [PDF, "ok.pdf"], [Buffer.from("just text"), "note.pdf"]);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_FILE_TYPE");
    expect(await storedFiles()).toHaveLength(0);
    expect(materialTables.deliveries[0]?.notes).toEqual([]);
  });

  it("refuses an upload with no file, and more than 10 files on one delivery", async () => {
    const d = seedDelivery();
    const nine = Array.from({ length: 9 }, (_, i): [Buffer, string] => [PDF, `p${i}.pdf`]);

    expect((await upload(d.id)).body.code).toBe("NO_FILE_PROVIDED");
    expect((await upload(d.id, ...nine)).status).toBe(201);
    const over = await upload(d.id, [PDF, "a.pdf"], [PDF, "b.pdf"]);

    expect(over.status).toBe(409);
    expect(over.body.code).toBe("DELIVERY_NOTE_LIMIT");
    expect(await storedFiles()).toHaveLength(9);
  });

  it("removes one file, refuses a file of another delivery, and removes every file with the delivery", async () => {
    const d = seedDelivery();
    const other = addDelivery({ villaId: d.villaId, factoryId: d.factoryId, lines: d.lines });
    const added = await upload(d.id, [PDF, "a.pdf"], [PDF, "b.pdf"]);
    const [a] = added.body.data.deliveryNotes as { id: string }[];

    const removed = await send("delete", `/material-deliveries/${d.id}/notes/${a!.id}`);
    const wrongDelivery = await send("get", `/material-deliveries/${other.id}/notes/${a!.id}`);

    expect(removed.body.data.deliveryNotes.map((n: { name: string }) => n.name)).toEqual(["b.pdf"]);
    expect(wrongDelivery.body.code).toBe("DELIVERY_NOTE_NOT_FOUND");
    expect(await storedFiles()).toHaveLength(1);

    await send("delete", `/material-deliveries/${d.id}`);

    expect(await storedFiles()).toHaveLength(0);
  });
});

describe("the balance", () => {
  // Every villa needs 1 MSB Box and 3 DB Interiors; V-101 needs 4 DB Interiors. V-101 received 1 MSB Box and 1 DB Interior,
  // V-202 received 2 DB Interiors.
  function seedBalance() {
    const s = seed();
    const other = addVilla({ villaNumber: "V-202" });
    s.msbBox.requiredPerVilla = 1;
    s.dbInterior.requiredPerVilla = 3;
    materialTables.requirements.push({ villaId: s.villa.id, itemId: s.dbInterior.id, quantity: 4 });
    addDelivery({
      villaId: s.villa.id,
      factoryId: s.switchgear.id,
      lines: [
        { itemId: s.msbBox.id, quantity: 1 },
        { itemId: s.dbInterior.id, quantity: 1 },
      ],
    });
    addDelivery({ villaId: other.id, factoryId: s.switchgear.id, lines: one(s.dbInterior.id, 2) });
    return { ...s, other };
  }

  it("lists what each villa still needs, with the totals still to come per material", async () => {
    const { dbInterior } = seedBalance();

    const res = await send("get", "/material-balance?status=PENDING");

    expect(res.status).toBe(200);
    expect(
      res.body.data.map((r: { villa: { villaNumber: string }; item: { name: string }; balance: number }) => [
        r.villa.villaNumber,
        r.item.name,
        r.balance,
      ]),
    ).toEqual([
      ["V-101", "DB Interior", 3],
      ["V-202", "MSB Box", 1],
      ["V-202", "DB Interior", 1],
    ]);
    expect(res.body.data[0]).toMatchObject({ required: 4, custom: true, delivered: 1, status: "PENDING" });
    expect(res.body.totals).toEqual([
      { item: expect.objectContaining({ name: "MSB Box" }), balance: 1, villas: 1 },
      {
        item: { id: dbInterior.id, name: "DB Interior", unit: "pcs", type: "SWITCHGEAR" },
        balance: 4,
        villas: 2,
      },
    ]);
    expect(res.body.meta.total).toBe(3);
  });

  it("filters by material, villa and status, and shows complete materials too", async () => {
    const { msbBox, villa } = seedBalance();

    const complete = await send("get", "/material-balance?status=COMPLETE");
    const byItem = await send("get", `/material-balance?itemId=${msbBox.id}`);
    const byVilla = await send("get", `/material-balance?villaId=${villa.id}`);

    expect(complete.body.data.map((r: { villa: { villaNumber: string } }) => r.villa.villaNumber)).toEqual([
      "V-101",
    ]);
    expect(byItem.body.data).toHaveLength(2);
    expect(byVilla.body.data.map((r: { status: string }) => r.status)).toEqual(["COMPLETE", "PENDING"]);
    expect((await send("get", "/material-balance?status=LATE")).status).toBe(400);
  });

  it("sets a villa's own quantities and gives one back to the catalog with null", async () => {
    const { villa, msbBox, dbInterior } = seedBalance();

    const res = await send("put", `/villas/${villa.id}/material-requirements`, {
      items: [
        { itemId: msbBox.id, quantity: 2 },
        { itemId: dbInterior.id, quantity: null },
      ],
    });

    expect(res.status).toBe(200);
    const byName = Object.fromEntries(
      res.body.data.materials.map(
        (m: { name: string; required: number; custom: boolean; balance: number }) => [
          m.name,
          [m.required, m.custom, m.balance],
        ],
      ),
    );
    expect(byName).toEqual({ "MSB Box": [2, true, 1], "DB Interior": [3, false, 2] });
    expect(auditActions()).toEqual(["villa.material_requirements"]);
    const unknown = await send("put", `/villas/${villa.id}/material-requirements`, {
      items: one(MISSING_ID),
    });
    expect(unknown.body.code).toBe("MATERIAL_ITEM_NOT_FOUND");
  });

  it("gives the villa summary: deliveries by type, notes, and each material's required, delivered and balance", async () => {
    const { villa } = seedBalance();

    const res = await send("get", `/villas/${villa.id}/materials-summary`);

    expect(res.body.data).toMatchObject({
      villaId: villa.id,
      deliveries: 1,
      withNote: 0,
      withoutNote: 1,
      byType: [
        { type: "SWITCHGEAR", deliveries: 1 },
        { type: "CABLE", deliveries: 0 },
      ],
      materials: [
        {
          name: "MSB Box",
          required: 1,
          custom: false,
          delivered: 1,
          balance: 0,
          status: "COMPLETE",
          deliveries: 1,
        },
        {
          name: "DB Interior",
          required: 4,
          custom: true,
          delivered: 1,
          balance: 3,
          status: "PENDING",
          deliveries: 1,
        },
      ],
    });
    expect((await send("get", `/villas/${MISSING_ID}/materials-summary`)).body.code).toBe("VILLA_NOT_FOUND");
  });
});
