import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// The villa scope on a real PostgreSQL (scratch schema): a user linked to an electrical engineer sees only that engineer's
// villas, in every list, count, page and picker, through the real services (Prisma queries and raw SQL alike), and cannot
// reach or change another engineer's villa. Without a scope (an ADMIN, a user not linked) nothing is limited.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { auth } from "../../src/core/middleware/auth.js";
import { signAccessToken } from "../../src/core/security/jwt.js";
import { currentVillaScope, runWithVillaScope, withVillaScope } from "../../src/core/scope/villa-scope.js";
import { CivilEngineersService } from "../../src/modules/civil-engineers/service/civil-engineers.service.js";
import { AuthService } from "../../src/modules/auth/service/auth.service.js";
import { DashboardService } from "../../src/modules/dashboard/service/dashboard.service.js";
import { DailyLabourService } from "../../src/modules/daily-labour/service/daily-labour.service.js";
import { DailyReportsService } from "../../src/modules/daily-reports/service/daily-reports.service.js";
import { ElectricalEngineersService } from "../../src/modules/electrical-engineers/service/electrical-engineers.service.js";
import { MaterialOrdersService } from "../../src/modules/material-orders/service/material-orders.service.js";
import { DeliveriesService } from "../../src/modules/materials/service/deliveries.service.js";
import { MonthlyProgressService } from "../../src/modules/monthly-progress/service/monthly-progress.service.js";
import { OpenWorksService } from "../../src/modules/open-works/service/open-works.service.js";
import { PaymentsService } from "../../src/modules/payments/service/payments.service.js";
import { SiteReportsService } from "../../src/modules/site-reports/service/site-reports.service.js";
import { SmallWorksService } from "../../src/modules/small-works/service/small-works.service.js";
import { UsersService } from "../../src/modules/users/service/users.service.js";
import { VillasService } from "../../src/modules/villas/service/villas.service.js";

const ctx = { locale: "en", requestId: "db-test", ip: "127.0.0.1", userAgent: "vitest" } as never;
const query = (extra: Record<string, unknown> = {}) => ({ page: 1, limit: 50, ...extra }) as never;
// The work runs, and is awaited, inside the scope, as a request handler is.
const asE1 = <T>(work: () => Promise<T>): Promise<T> =>
  runWithVillaScope({ engineerId: "e1" }, async () => await work());
const PH = "00000000-0000-4000-8000-0000000000c1";

describe.skipIf(!RUN)("the villa scope on a real database (scratch schema)", () => {
  let scratch: ScratchDatabase;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);

  beforeAll(async () => {
    scratch = await openScratch("scratchvillascope", 3);
    // The client the app uses: every model query carries the scope.
    scratchHolder.client = withVillaScope(scratch.prisma as never) as unknown as Record<
      string | symbol,
      unknown
    >;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES
       ('admin','Root','root@x.test','x','ADMIN',true,now()),
       ('u1','Eng One','one@x.test','x','EMPLOYEE',true,now()),
       ('u3','Plain','plain@x.test','x','EMPLOYEE',true,now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('ce','Civil','011',now())`,
    );
    await q(
      `INSERT INTO "ElectricalEngineer" ("id","name","phone","userId","updatedAt") VALUES
       ('e1','Eng One','012','u1',now()), ('e2','Eng Two','013',NULL,now())`,
    );
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES ('c1','Nile','0100','ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","electricalEngineerId","contractorId","createdById","areaId","updatedAt") VALUES
       ('va','V-A','B1','1','ce','e1','c1','admin','area',now()),
       ('vb','V-B','B1','2','ce','e2','c1','admin','area',now())`,
    );
    await q(`UPDATE "ElecPhase" SET "status" = 'INACTIVE'`);
    await q(
      `INSERT INTO "ElecPhase" ("id","name","sortOrder","progressRatio","status","updatedAt") VALUES ('${PH}','Scope phase',901,100,'ACTIVE',now())`,
    );
    await q(
      `INSERT INTO "WorkItem" ("id","villaId","elecPhaseId","source","updatedAt") VALUES
       ('wa','va','${PH}','MANUAL',now()), ('wb','vb','${PH}','MANUAL',now())`,
    );
    await q(
      `INSERT INTO "DailySmallWork" ("id","villaId","contractorId","startDate","endDate","description","updatedAt") VALUES
       ('swa','va','c1','2026-11-01','2026-11-30','A work',now()), ('swb','vb','c1','2026-11-01','2026-11-30','B work',now())`,
    );
    await q(
      `INSERT INTO "SiteReport" ("id","villaId","title","visitDate","inspector","type","rating","findings","updatedAt") VALUES
       ('sra','va','A visit','2026-11-02','Ali','INSPECTION',4,'ok',now()), ('srb','vb','B visit','2026-11-02','Ali','INSPECTION',2,'bad',now())`,
    );
    await q(
      `INSERT INTO "DailyLabour" ("id","villaId","labourDate","contractorId","labourCount","updatedAt") VALUES
       ('la','va','2026-11-03','c1',5,now()), ('lb','vb','2026-11-03','c1',9,now())`,
    );
    await q(
      `INSERT INTO "DailyReport" ("id","reportDate","weather","workersCount","contractorId","preparedByEngineerId","updatedAt") VALUES
       ('dra','2026-11-04','SUNNY',3,'c1','e1',now()), ('drb','2026-11-05','SUNNY',7,'c1','e2',now())`,
    );
    await q(
      `INSERT INTO "ContractorPayment" ("id","contractorId","villaId","amountMinor","updatedAt") VALUES
       ('pa','c1','va',1000,now()), ('pb','c1','vb',2000,now()), ('pg','c1',NULL,3000,now())`,
    );
    await q(`INSERT INTO "Factory" ("id","name","type","updatedAt") VALUES ('sw','Gulf','SWITCHGEAR',now())`);
    await q(
      `INSERT INTO "MaterialItem" ("id","name","type","unit","requiredPerVilla","updatedAt") VALUES ('msb','MSB','SWITCHGEAR','pcs',1,now())`,
    );
  });

  afterAll(async () => {
    await scratch?.dispose();
  });

  const villasOf = (rows: { villa?: { villaNumber: string }; villaNumber?: string }[]) =>
    [...new Set(rows.map((row) => row.villa?.villaNumber ?? row.villaNumber))].sort();

  it("lists, pickers and pages show only the engineer's villas", async () => {
    const villas = new VillasService();
    expect(villasOf((await asE1(() => villas.list(query()))).items)).toEqual(["V-A"]);
    expect((await asE1(() => villas.options())).map((v) => v.villaNumber)).toEqual(["V-A"]);
    await expect(asE1(() => villas.get("vb", ctx))).rejects.toMatchObject({ code: "VILLA_NOT_FOUND" });
    expect((await asE1(() => villas.get("va", ctx))).villaNumber).toBe("V-A");
    // Without a scope, everything.
    expect((await villas.list(query())).meta.total).toBe(2);
  });

  it("every villa-related list follows the scope, raw SQL and Prisma alike", async () => {
    const works = new OpenWorksService();
    expect(villasOf((await asE1(() => works.list(query()))).items)).toEqual(["V-A"]);
    await expect(asE1(() => works.get("wb", ctx))).rejects.toMatchObject({ statusCode: 404 });

    expect(villasOf((await asE1(() => new SmallWorksService().list(query()))).items)).toEqual(["V-A"]);
    expect(villasOf((await asE1(() => new SiteReportsService().list(query()))).items)).toEqual(["V-A"]);
    expect(villasOf((await asE1(() => new DailyLabourService().list(query()))).items)).toEqual(["V-A"]);
    await expect(asE1(() => new SiteReportsService().get("srb", ctx))).rejects.toMatchObject({
      statusCode: 404,
    });

    const reports = await asE1(() => new DailyReportsService().list(query()));
    expect(reports.items.map((r) => r.id)).toEqual(["dra"]);

    const payments = await asE1(() => new PaymentsService().list(query()));
    expect(payments.items.map((p) => p.id)).toEqual(["pa"]);
    expect((await new PaymentsService().list(query())).meta.total).toBe(3);

    expect(villasOf((await asE1(() => new MaterialOrdersService().list(query()))).items)).toEqual(["V-A"]);
    expect(
      villasOf((await asE1(() => new DeliveriesService().balanceList(query({ status: undefined })))).items),
    ).toEqual(["V-A"]);
    expect(
      villasOf((await asE1(() => new MonthlyProgressService().list(query({ owed: false })))).items),
    ).toEqual(["V-A"]);
  });

  it("the dashboard counts only the engineer's villas and records", async () => {
    const dashboard = new DashboardService();
    const admin = { id: "admin", role: "ADMIN" } as never;
    const scoped = await asE1(() => dashboard.summary(admin));
    const all = await dashboard.summary(admin);
    expect(scoped.villas?.total).toBe(1);
    expect(all.villas?.total).toBe(2);
    expect(JSON.stringify(scoped)).not.toContain("V-B");
  });

  it("another engineer's villa cannot be changed or written to", async () => {
    const db = scratchHolder.client as unknown as {
      villa: { updateMany: (a: unknown) => Promise<{ count: number }> };
      workItem: {
        create: (a: unknown) => Promise<unknown>;
        deleteMany: (a: unknown) => Promise<{ count: number }>;
      };
    };
    expect(
      (await asE1(() => db.villa.updateMany({ where: { id: "vb" }, data: { ownerName: "x" } }))).count,
    ).toBe(0);
    await expect(
      asE1(() => db.workItem.create({ data: { villaId: "vb", elecPhaseId: PH, source: "MANUAL" } })),
    ).rejects.toMatchObject({ code: "P2025" });
    expect((await asE1(() => db.workItem.deleteMany({ where: { villaId: "vb" } }))).count).toBe(0);
    expect(
      (await asE1(() => db.villa.updateMany({ where: { id: "va" }, data: { ownerName: "Owner A" } }))).count,
    ).toBe(1);
  });

  it("a villa an engineer adds is its own, and it cannot give one to another engineer", async () => {
    const villas = new VillasService();
    const actor = { id: "u1", role: "EMPLOYEE" } as never;
    const base = { block: "B9", areaId: "area", civilEngineerId: "ce" };
    // No engineer named: it goes to the signed-in engineer (this was "Villa not found" before).
    const created = await asE1(() =>
      villas.create(actor, { ...base, plot: "91", villaNumber: "V-NEW" } as never, ctx),
    );
    expect((await asE1(() => villas.get(created.id, ctx))).electricalEngineer?.id).toBe("e1");
    await expect(
      asE1(() =>
        villas.create(
          actor,
          { ...base, plot: "92", villaNumber: "V-OTHER", electricalEngineerId: "e2" } as never,
          ctx,
        ),
      ),
    ).rejects.toMatchObject({ code: "VILLA_ENGINEER_OUT_OF_SCOPE" });
    await expect(
      asE1(() => villas.update(actor, created.id, { electricalEngineerId: "e2" } as never, ctx)),
    ).rejects.toMatchObject({ code: "VILLA_ENGINEER_OUT_OF_SCOPE" });
    // An ADMIN gives villas to any engineer.
    const adminVilla = await villas.create(
      { id: "admin", role: "ADMIN" } as never,
      { ...base, plot: "93", villaNumber: "V-ADM", electricalEngineerId: "e2" } as never,
      ctx,
    );
    expect(adminVilla.villaNumber).toBe("V-ADM");
  });

  it("an engineer changes its villas but never deletes one, and its permissions say so", async () => {
    const villas = new VillasService();
    const engineerActor = { id: "u1", role: "EMPLOYEE" } as never;
    await expect(asE1(() => villas.remove(engineerActor, "va", ctx))).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "An electrical engineer can change villas but not delete them",
    });
    expect((await villas.get("va", ctx)).villaNumber).toBe("V-A");
    // It can still change its own villa.
    const changed = await asE1(() =>
      villas.update(engineerActor, "va", { ownerName: "Owner B" } as never, ctx),
    );
    expect(changed.ownerName).toBe("Owner B");

    await q(
      `INSERT INTO "Permission" ("id","code") VALUES ('pdel','villas:delete') ON CONFLICT ("code") DO NOTHING`,
    );
    await q(
      `INSERT INTO "UserPermission" ("userId","permissionId") SELECT 'u1', "id" FROM "Permission" WHERE "code" = 'villas:delete' ON CONFLICT DO NOTHING`,
    );
    const auth = new AuthService();
    const scoped = await asE1(() => auth.getMe("u1", ctx));
    expect(scoped.permissions).not.toContain("villas:delete");
    const unscoped = await auth.getMe("u1", ctx);
    expect(unscoped.permissions).toContain("villas:delete");
    // The app hides the budget and the payments owed by this flag; only a linked engineer has it.
    expect(scoped.engineerScope).toBe(true);
    expect(unscoped).not.toHaveProperty("engineerScope");
  });

  it("links one user per engineer, never an ADMIN, and lists the users to pick", async () => {
    const engineers = new ElectricalEngineersService();
    const actor = { id: "admin", role: "ADMIN" } as never;
    const created = await engineers.create(
      actor,
      { name: "Eng Three", phone: "014", userId: "u3" } as never,
      ctx,
    );
    expect(created.user).toMatchObject({ id: "u3", email: "plain@x.test" });
    await expect(engineers.update(actor, "e2", { userId: "u1" } as never, ctx)).rejects.toMatchObject({
      code: "ENGINEER_USER_TAKEN",
    });
    await expect(engineers.update(actor, "e2", { userId: "admin" } as never, ctx)).rejects.toMatchObject({
      code: "ENGINEER_USER_ADMIN",
    });
    await expect(
      engineers.update(actor, "e2", { userId: "00000000-0000-4000-8000-00000000dead" } as never, ctx),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    expect((await engineers.userOptions()).map((o) => [o.id, o.engineer?.id ?? null])).toEqual([
      ["u1", "e1"],
      ["u3", created.id],
    ]);
    expect((await engineers.update(actor, created.id, { userId: null } as never, ctx)).user).toBeNull();
  });

  it("auth gives a linked engineer its scope, and an ADMIN or a user not linked none", async () => {
    const scopeOf = async (userId: string, role: "ADMIN" | "EMPLOYEE") => {
      const token = await signAccessToken({ id: userId, role });
      const req = { headers: { authorization: `Bearer ${token}` }, locale: "en" } as never;
      return new Promise<unknown>((resolve, reject) => {
        void auth(req, {} as never, (err?: unknown) =>
          err ? reject(err) : resolve(currentVillaScope()),
        ).catch(reject);
      });
    };
    expect(await scopeOf("u1", "EMPLOYEE")).toEqual({ engineerId: "e1" });
    expect(await scopeOf("u3", "EMPLOYEE")).toBeUndefined();
    await q(`UPDATE "ElectricalEngineer" SET "userId" = 'admin' WHERE "id" = 'e2'`);
    expect(await scopeOf("admin", "ADMIN")).toBeUndefined();
    await q(`UPDATE "ElectricalEngineer" SET "userId" = NULL WHERE "id" = 'e2'`);
  });

  it("keeps the account of an engineer who still has villas, until they are moved to another engineer", async () => {
    const users = new UsersService();
    const admin = { id: "admin", role: "ADMIN" } as never;
    await q(`UPDATE "ElectricalEngineer" SET "userId" = 'u3' WHERE "id" = 'e2'`);
    await expect(users.remove(admin, "u3", ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_ENGINEER_HAS_VILLAS",
      message: expect.stringContaining("Eng Two"),
    });
    // Every villa of the engineer moved to another one: the account can go.
    await q(`UPDATE "Villa" SET "electricalEngineerId" = 'e1' WHERE "electricalEngineerId" = 'e2'`);
    await users.remove(admin, "u3", ctx);
    expect((await q(`SELECT count(*)::int AS n FROM "User" WHERE "id" = 'u3'`)).rows[0].n).toBe(0);
  });

  it("moves every villa of an engineer to another in one go, audited, and never for an engineer's own account", async () => {
    const admin = { id: "admin", role: "ADMIN" } as never;
    const electrical = new ElectricalEngineersService();
    const civil = new CivilEngineersService();
    const villasOf = async (column: string, id: string) =>
      (
        await q(`SELECT "villaNumber" FROM "Villa" WHERE "${column}" = $1 ORDER BY "villaNumber"`, [id])
      ).rows.map((row: { villaNumber: string }) => row.villaNumber);
    const versions = async () =>
      (await q(`SELECT "version" FROM "Villa" ORDER BY "villaNumber"`)).rows.map(
        (row: { version: number }) => row.version,
      );

    // Every villa is e1's by now (earlier tests added some); e2 has none.
    const all = (await q(`SELECT "villaNumber" FROM "Villa" ORDER BY "villaNumber"`)).rows.map(
      (row: { villaNumber: string }) => row.villaNumber,
    );
    expect(await villasOf("electricalEngineerId", "e1")).toEqual(all);
    const civilAll = await villasOf("civilEngineerId", "ce");

    // The engineer's own account cannot hand its villas away.
    await expect(
      asE1(() => electrical.transferVillas(admin, "e1", { toEngineerId: "e2" }, ctx)),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
    });
    expect(await villasOf("electricalEngineerId", "e1")).toEqual(all);

    const before = await versions();
    expect(await electrical.transferVillas(admin, "e1", { toEngineerId: "e2" }, ctx)).toEqual({
      moved: all.length,
      to: { id: "e2", name: "Eng Two" },
    });
    expect(await villasOf("electricalEngineerId", "e2")).toEqual(all);
    expect(await versions()).toEqual(before.map((v: number) => v + 1));
    const audit = await q(
      `SELECT "entityId", "after" FROM "AuditLog" WHERE "action" = 'electrical_engineer.transfer_villas'`,
    );
    expect(audit.rows).toEqual([
      {
        entityId: "e1",
        after: { from: "Eng One", to: "Eng Two", moved: all.length, villas: expect.arrayContaining(all) },
      },
    ]);
    // Back again, so the engineer's account keeps its villas.
    await electrical.transferVillas(admin, "e2", { toEngineerId: "e1" }, ctx);
    expect(await villasOf("electricalEngineerId", "e1")).toEqual(all);

    // Civil engineers alike; an inactive engineer cannot take them, and nothing moves.
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('ce2','Civil Two','014',now())`,
    );
    await q(
      `INSERT INTO "CivilEngineer" ("id","name","phone","status","updatedAt") VALUES ('ce3','Civil Off','015','INACTIVE',now())`,
    );
    await expect(civil.transferVillas(admin, "ce", { toEngineerId: "ce3" }, ctx)).rejects.toMatchObject({
      code: "CIVIL_ENGINEER_INACTIVE",
    });
    expect(await villasOf("civilEngineerId", "ce")).toEqual(civilAll);
    expect((await civil.transferVillas(admin, "ce", { toEngineerId: "ce2" }, ctx)).moved).toBe(
      civilAll.length,
    );
    expect(await villasOf("civilEngineerId", "ce2")).toEqual(civilAll);
    // With no villas left the engineer can be deleted.
    await civil.remove(admin, "ce", ctx);
    expect((await q(`SELECT count(*)::int AS n FROM "CivilEngineer" WHERE "id" = 'ce'`)).rows[0].n).toBe(0);
  });

  it("an electrical engineer's account cannot be made an ADMIN; another user can, and back", async () => {
    const users = new UsersService();
    const admin = { id: "admin", role: "ADMIN" } as never;
    await expect(users.setRole(admin, "u1", { role: "ADMIN" }, ctx)).rejects.toMatchObject({
      statusCode: 409,
      code: "USER_IS_ENGINEER_ACCOUNT",
    });
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES ('u9','Office','office@x.test','x','EMPLOYEE',true,now())`,
    );
    expect((await users.setRole(admin, "u9", { role: "ADMIN" }, ctx)).role).toBe("ADMIN");
    const roles = await q(`SELECT "role" FROM "User" WHERE "role" = 'ADMIN' ORDER BY "id"`);
    expect(roles.rows).toHaveLength(2);
    expect((await users.setRole(admin, "u9", { role: "EMPLOYEE" }, ctx)).role).toBe("EMPLOYEE");
    const audit = await q(
      `SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'user.role_change' AND "entityId" = 'u9'`,
    );
    expect(audit.rows[0].n).toBe(2);
  });
});
