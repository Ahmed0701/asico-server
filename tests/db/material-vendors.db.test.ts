import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The villa vendors on a real PostgreSQL (scratch schema): assigning each villa its switchgear and cable factories
// (of the right type, with the villa's version), the list with its filters and counts, and the factories kept while
// assigned.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { FactoriesService } from "../../src/modules/materials/service/factories.service.js";
import { MaterialVendorsService } from "../../src/modules/material-vendors/service/material-vendors.service.js";

const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const admin = { id: "admin", role: "ADMIN" } as never;
const query = (extra: Record<string, unknown> = {}) => ({ page: 1, limit: 20, ...extra }) as never;
const GULF = "11111111-1111-4111-8111-111111111111";
const ALFANAR = "22222222-2222-4222-8222-222222222222";
const KC = "33333333-3333-4333-8333-333333333333";
const V2 = "a0000000-0000-4000-8000-000000000002";
const V10 = "a0000000-0000-4000-8000-000000000010";
const V3 = "a0000000-0000-4000-8000-000000000003";

describe.skipIf(!RUN)("villa vendors on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const service = new MaterialVendorsService();
  const factories = new FactoriesService();

  beforeAll(async () => {
    scratch = await openScratch("scratchvendors", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('admin','Root','a@x.test','x','ADMIN',true,now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Mona','012',now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","updatedAt") VALUES
       ($1,'V-2','B','2','eng','admin','area',now()), ($2,'V-10','B','10','eng','admin','area',now()),
       ($3,'V-3','B','3','eng','admin','area',now())`,
      [V2, V10, V3],
    );
    await q(
      `INSERT INTO "Factory" ("id","name","type","updatedAt") VALUES
       ($1,'Gulf Switchgear','SWITCHGEAR',now()), ($2,'Alfanar','SWITCHGEAR',now()), ($3,'Kuwait Cables','CABLE',now())`,
      [GULF, ALFANAR, KC],
    );
  }, 180_000);

  afterAll(async () => {
    await scratch?.dispose();
  });

  it("lists only the villas added by hand, offers the others to add, and refuses adding one twice", async () => {
    const empty = await service.list(query());
    expect(empty.items).toEqual([]);
    // Nothing assigned yet counts every villa of the project, the ones not on the list too.
    expect(empty.summary).toEqual({ villaCount: 0, withSwitchgear: 0, withCable: 0, withNone: 3 });
    expect((await service.available()).map((v) => v.villaNumber)).toEqual(["V-2", "V-3", "V-10"]);
    // A villa not on the list cannot be assigned a factory.
    await expect(service.assign(admin, V3, { cableFactoryId: KC }, ctx)).rejects.toMatchObject({
      code: "VILLA_NOT_IN_VENDORS",
    });

    const added = await service.add(admin, V2, ctx);
    expect(added).toMatchObject({ villa: { villaNumber: "V-2" }, switchgear: null, cable: null });
    expect(added.listedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await service.add(admin, V10, ctx);
    await service.add(admin, V3, ctx);
    await expect(service.add(admin, V2, ctx)).rejects.toMatchObject({ code: "VILLA_ALREADY_IN_VENDORS" });
    await expect(service.add(admin, "a0000000-0000-4000-8000-000000000099", ctx)).rejects.toMatchObject({
      code: "VILLA_NOT_FOUND",
    });
    expect(await service.available()).toEqual([]);
  });

  it("assigns a villa its factories, moves the villa's version on, and audits it", async () => {
    const before = await service.list(query());
    expect(before.items.map((item) => item.villa.villaNumber)).toEqual(["V-2", "V-3", "V-10"]);
    const v2 = before.items[0]!;
    expect(v2).toMatchObject({ switchgear: null, cable: null });

    const saved = await service.assign(
      admin,
      V2,
      { switchgearFactoryId: GULF, cableFactoryId: KC },
      ctx,
      v2.version,
    );
    expect(saved).toMatchObject({
      switchgear: { id: GULF, name: "Gulf Switchgear" },
      cable: { id: KC, name: "Kuwait Cables" },
      version: v2.version + 1,
    });
    // Only what is sent changes; a stale version is refused.
    const changed = await service.assign(admin, V2, { switchgearFactoryId: ALFANAR }, ctx, saved.version);
    expect(changed).toMatchObject({ switchgear: { name: "Alfanar" }, cable: { name: "Kuwait Cables" } });
    await expect(
      service.assign(admin, V2, { cableFactoryId: null }, ctx, saved.version),
    ).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    await service.assign(admin, V10, { cableFactoryId: KC }, ctx);

    const audit = await q(
      `SELECT "after" FROM "AuditLog" WHERE "action" = 'villa.vendors' ORDER BY "createdAt"`,
    );
    expect(audit.rows[0].after).toEqual({
      villaNumber: "V-2",
      switchgearFactory: "Gulf Switchgear",
      cableFactory: "Kuwait Cables",
    });
  });

  it("refuses a factory of the other type, an unknown factory, and an unknown villa", async () => {
    await expect(service.assign(admin, V3, { switchgearFactoryId: KC }, ctx)).rejects.toMatchObject({
      code: "FACTORY_WRONG_TYPE",
    });
    await expect(service.assign(admin, V3, { cableFactoryId: GULF }, ctx)).rejects.toMatchObject({
      code: "FACTORY_WRONG_TYPE",
    });
    await expect(
      service.assign(admin, V3, { cableFactoryId: "44444444-4444-4444-8444-444444444444" }, ctx),
    ).rejects.toMatchObject({ code: "FACTORY_NOT_FOUND" });
    await expect(
      service.assign(admin, "a0000000-0000-4000-8000-000000000099", { cableFactoryId: KC }, ctx),
    ).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });
  });

  it("lists with the counts, filters by factory and by a type still missing, and searches", async () => {
    const all = await service.list(query());
    expect(all.summary).toEqual({ villaCount: 3, withSwitchgear: 1, withCable: 2, withNone: 1 });
    // The filters do not change it.
    expect((await service.list(query({ search: "alfanar" }))).summary).toMatchObject({
      villaCount: 1,
      withNone: 1,
    });
    const names = async (extra: Record<string, unknown>) =>
      (await service.list(query(extra))).items.map((item) => item.villa.villaNumber);
    expect(await names({ factoryId: KC })).toEqual(["V-2", "V-10"]);
    expect(await names({ missing: "SWITCHGEAR" })).toEqual(["V-3", "V-10"]);
    expect(await names({ missing: "CABLE" })).toEqual(["V-3"]);
    expect(await names({ search: "alfanar" })).toEqual(["V-2"]);
    expect(await names({ sort: "villaNumber:desc" })).toEqual(["V-10", "V-3", "V-2"]);
  });

  it("keeps a factory assigned to villas from being deleted or moved to the other type, until it is taken off", async () => {
    const [kc] = (await factories.list({ type: "CABLE" } as never)).filter((f) => f.id === KC);
    await expect(factories.remove(admin, KC, ctx)).rejects.toMatchObject({ code: "FACTORY_ASSIGNED" });
    await expect(factories.update(admin, KC, { type: "SWITCHGEAR" }, ctx)).rejects.toMatchObject({
      code: "FACTORY_ASSIGNED",
    });
    // Renaming is fine.
    expect((await factories.update(admin, KC, { name: "KC Cables" }, ctx)).name).toBe("KC Cables");
    expect(kc).toBeDefined();

    await service.assign(admin, V2, { cableFactoryId: null }, ctx);
    await service.assign(admin, V10, { cableFactoryId: null }, ctx);
    await factories.remove(admin, KC, ctx);
    expect((await service.list(query())).summary.withCable).toBe(0);
  });

  it("takes a villa off the list with its factories, offers it again, and audits it", async () => {
    await service.assign(admin, V2, { switchgearFactoryId: GULF }, ctx);
    const row = (await service.list(query())).items.find((item) => item.villa.id === V2)!;
    await expect(service.remove(admin, V2, ctx, row.version - 1)).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
    });
    await service.remove(admin, V2, ctx, row.version);

    expect((await service.list(query())).items.map((item) => item.villa.villaNumber)).toEqual([
      "V-3",
      "V-10",
    ]);
    expect((await service.available()).map((v) => v.villaNumber)).toEqual(["V-2"]);
    const villa = await q(`SELECT "switchgearFactoryId","cableFactoryId" FROM "Villa" WHERE "id" = $1`, [V2]);
    expect(villa.rows[0]).toEqual({ switchgearFactoryId: null, cableFactoryId: null });
    await expect(service.remove(admin, V2, ctx)).rejects.toMatchObject({ code: "VILLA_NOT_IN_VENDORS" });
    const audit = await q(
      `SELECT "action" FROM "AuditLog" WHERE "action" LIKE 'villa.vendors_%' ORDER BY "createdAt"`,
    );
    expect(audit.rows.map((r: { action: string }) => r.action)).toEqual([
      "villa.vendors_add",
      "villa.vendors_add",
      "villa.vendors_add",
      "villa.vendors_remove",
    ]);
  });

  it("reads one villa's assigned factories, on the list or not", async () => {
    // V-2 was taken off the list above: nothing assigned, not listed.
    expect(await service.get(V2, ctx)).toMatchObject({
      villa: { villaNumber: "V-2" },
      switchgear: null,
      cable: null,
      listedAt: null,
    });
    await service.assign(admin, V3, { switchgearFactoryId: GULF }, ctx);
    const v3 = await service.get(V3, ctx);
    expect(v3.switchgear).toEqual({ id: GULF, name: "Gulf Switchgear" });
    expect(v3.listedAt).not.toBeNull();
    await expect(service.get("a0000000-0000-4000-8000-000000000099", ctx)).rejects.toMatchObject({
      code: "VILLA_NOT_FOUND",
    });
  });
});
