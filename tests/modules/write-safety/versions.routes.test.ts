import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addArea } from "../areas/in-memory-areas.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import {
  addContractor,
  contractorTables,
  InMemoryContractorsRepository,
} from "../contractors/in-memory-contractors.repository.js";
import { InMemoryCivilEngineersRepository } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { permissionTable } from "../permissions/in-memory-permissions.repository.js";
import { InMemoryUsersRepository } from "../users/in-memory-users.repository.js";
import { addVilla, InMemoryVillasRepository, villaTables } from "../villas/in-memory-villas.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/auth/repository/auth.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/auth/repository/auth.repository.js")>()),
  AuthRepository: (await import("../auth/in-memory-auth.repository.js")).InMemoryAuthRepository,
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
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/users/repository/users.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/users/repository/users.repository.js")>()),
  UsersRepository: (await import("../users/in-memory-users.repository.js")).InMemoryUsersRepository,
}));
vi.mock("../../../src/modules/permissions/repository/permissions.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/permissions/repository/permissions.repository.js")
  >()),
  PermissionsRepository: (await import("../permissions/in-memory-permissions.repository.js"))
    .InMemoryPermissionsRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const MISSING = randomUUID();

let admin: User;
beforeEach(() => {
  store.reset();
  contractorTables.reset();
  engineerTables.reset();
  villaTables.reset();
  permissionTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});
afterEach(() => {
  vi.restoreAllMocks();
});

type Verb = "get" | "post" | "patch" | "delete";
async function call(
  verb: Verb,
  path: string,
  options: { ifMatch?: string; body?: unknown; language?: string } = {},
) {
  const agent = request(app);
  const req = agent[verb](`/api/v1${path}`).set({
    Authorization: `Bearer ${await signAccessToken({ id: admin.id, role: admin.role })}`,
    "Accept-Language": options.language ?? "en",
  });
  if (options.ifMatch !== undefined) {
    req.set("If-Match", options.ifMatch);
  }
  return options.body === undefined ? req : req.send(options.body as object);
}

const audits = (action: string) => store.auditRows.filter((row) => row.action === action);
const conflict = (res: request.Response, current: number) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("VERSION_CONFLICT");
  expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: current }]);
};

describe("what a browser on another origin may read", () => {
  it("exposes Idempotent-Replayed, Retry-After, ETag, X-Request-Id and Content-Disposition, and nothing else", async () => {
    const { env } = await import("../../../src/core/config/env.js");
    const origin = env.CORS_ORIGINS[0] ?? "http://localhost:5173";
    const original = env.CORS_ORIGINS;
    env.CORS_ORIGINS.splice(0, env.CORS_ORIGINS.length, origin);
    try {
      const res = await request(app)
        .get("/api/v1/contractors")
        .set({
          Authorization: `Bearer ${await signAccessToken({ id: admin.id, role: admin.role })}`,
          Origin: origin,
        });

      const exposed = String(res.headers["access-control-expose-headers"]).split(/\s*,\s*/);
      expect([...exposed].sort()).toEqual([
        "Content-Disposition",
        "ETag",
        "Idempotent-Replayed",
        "Retry-After",
        "X-Request-Id",
      ]);
      // The id a person quotes in a report is really sent, so there is something to read.
      expect(res.headers["x-request-id"]).toEqual(expect.any(String));
    } finally {
      env.CORS_ORIGINS.splice(0, env.CORS_ORIGINS.length, ...original);
    }
  });
});

describe("contractors", () => {
  const seed = () => addContractor({ name: "Nile Builders" });

  it("shows its version in the item, the list and after creating, and an ETag on the single item", async () => {
    const created = await call("post", "/contractors", { body: { name: "New One", phone: "0100 123 4567" } });
    const single = await call("get", `/contractors/${created.body.data.id}`);
    const list = await call("get", "/contractors");

    expect(created.body.data.version).toBe(1);
    expect(single.body.data.version).toBe(1);
    expect(single.headers["etag"]).toBe('"1"');
    expect(single.headers["cache-control"]).toBe("private, no-store");
    expect(list.body.data[0].version).toBe(1);
    // Only the single item carries the version as its ETag; other responses keep Express's own content hash.
    expect(created.headers["etag"]).not.toBe('"1"');
  });

  it("goes up by one with every update, with or without If-Match, and the ETag follows", async () => {
    const row = seed();

    const first = await call("patch", `/contractors/${row.id}`, { body: { name: "A" } });
    const second = await call("patch", `/contractors/${row.id}`, { body: { name: "B" }, ifMatch: "2" });
    const third = await call("patch", `/contractors/${row.id}`, { body: { name: "C" }, ifMatch: '"3"' });
    const fourth = await call("patch", `/contractors/${row.id}`, { body: { name: "D" }, ifMatch: 'W/"4"' });
    const fifth = await call("patch", `/contractors/${row.id}`, { body: { name: "E" }, ifMatch: "*" });

    expect([first, second, third, fourth, fifth].map((res) => res.status)).toEqual([200, 200, 200, 200, 200]);
    expect([first, second, third, fourth, fifth].map((res) => res.body.data.version)).toEqual([
      2, 3, 4, 5, 6,
    ]);
    expect(fifth.headers["etag"]).toBe('"6"');
    expect(contractorTables.contractors[0]?.version).toBe(6);
    expect(audits("contractor.update")).toHaveLength(5);
  });

  it("a stale If-Match is 409 VERSION_CONFLICT with the current version in the details, and changes nothing", async () => {
    const row = seed();
    await call("patch", `/contractors/${row.id}`, { body: { name: "Second" } });

    const stale = await call("patch", `/contractors/${row.id}`, { body: { name: "Third" }, ifMatch: "1" });

    conflict(stale, 2);
    expect(contractorTables.contractors[0]).toMatchObject({ name: "Second", version: 2 });
    expect(audits("contractor.update")).toHaveLength(1);
  });

  it("is also refused for a version that is ahead of the record, and in Arabic for an Arabic request", async () => {
    const row = seed();

    const ahead = await call("patch", `/contractors/${row.id}`, {
      body: { name: "X" },
      ifMatch: "7",
      language: "ar",
    });

    expect(ahead.status).toBe(409);
    expect(ahead.body.message).toBe("تم تعديل هذا السجل بواسطة شخص آخر. أعد تحميله وحاول مرة أخرى");
    expect(ahead.body.details).toEqual([{ path: "version", message: "الإصدار الحالي", value: 1 }]);
    expect(contractorTables.contractors[0]?.version).toBe(1);
  });

  it.each(["abc", "0", "-3", "1.5", "1,2", ""])(
    "a malformed If-Match (%j) is 400 INVALID_IF_MATCH",
    async (header) => {
      const row = seed();

      const res = await call("patch", `/contractors/${row.id}`, { body: { name: "X" }, ifMatch: header });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_IF_MATCH");
      expect(contractorTables.contractors[0]?.version).toBe(1);
    },
  );

  it("is 404 for an unknown contractor, whatever If-Match says", async () => {
    const res = await call("patch", `/contractors/${MISSING}`, { body: { name: "X" }, ifMatch: "9" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CONTRACTOR_NOT_FOUND");
  });

  describe("two requests that read the same version", () => {
    it("with If-Match: one wins and the other is 409; the record has changed once", async () => {
      const row = seed();

      const [a, b] = await Promise.all([
        call("patch", `/contractors/${row.id}`, { body: { name: "From A" }, ifMatch: "1" }),
        call("patch", `/contractors/${row.id}`, { body: { name: "From B" }, ifMatch: "1" }),
      ]);

      const winner = [a, b].find((res) => res.status === 200)!;
      const loser = [a, b].find((res) => res.status === 409)!;
      expect(winner).toBeDefined();
      conflict(loser, 2);
      expect(contractorTables.contractors[0]?.version).toBe(2);
      expect(contractorTables.contractors[0]?.name).toBe(winner.body.data.name);
      expect(audits("contractor.update")).toHaveLength(1);
    });

    it("many of them: exactly one wins", async () => {
      const row = seed();

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          call("patch", `/contractors/${row.id}`, { body: { name: `Name ${i}` }, ifMatch: "1" }),
        ),
      );

      expect(results.filter((res) => res.status === 200)).toHaveLength(1);
      expect(results.filter((res) => res.status === 409)).toHaveLength(7);
      expect(contractorTables.contractors[0]?.version).toBe(2);
    });

    it("without If-Match: both go through in turn, and each audit entry records exactly what its write replaced", async () => {
      const row = seed();

      const [a, b] = await Promise.all([
        call("patch", `/contractors/${row.id}`, { body: { name: "From A" } }),
        call("patch", `/contractors/${row.id}`, { body: { name: "From B" } }),
      ]);

      expect([a.status, b.status]).toEqual([200, 200]);
      expect(contractorTables.contractors[0]?.version).toBe(3);
      const [first, second] = audits("contractor.update") as unknown as {
        before: { name: string };
        after: { name: string };
      }[];
      expect(first?.before.name).toBe("Nile Builders");
      expect(second?.before.name).toBe(first?.after.name);
    });

    it("a write that loses the race between the lock and the update is 409 too, not a silent overwrite", async () => {
      const row = seed();
      vi.spyOn(InMemoryContractorsRepository.prototype, "update").mockResolvedValueOnce(null);

      const res = await call("patch", `/contractors/${row.id}`, { body: { name: "X" } });

      conflict(res, 1);
      expect(audits("contractor.update")).toHaveLength(0);
    });
  });

  describe("DELETE", () => {
    it("with a stale If-Match is 409 and the contractor stays", async () => {
      const row = seed();
      await call("patch", `/contractors/${row.id}`, { body: { name: "Moved" } });

      const res = await call("delete", `/contractors/${row.id}`, { ifMatch: "1" });

      conflict(res, 2);
      expect(contractorTables.contractors).toHaveLength(1);
      expect(audits("contractor.delete")).toHaveLength(0);
    });

    it("with the current version, with *, and with no header, deletes", async () => {
      const a = seed();
      const b = seed();
      const c = seed();

      const results = [
        await call("delete", `/contractors/${a.id}`, { ifMatch: "1" }),
        await call("delete", `/contractors/${b.id}`, { ifMatch: "*" }),
        await call("delete", `/contractors/${c.id}`),
      ];

      expect(results.map((res) => res.status)).toEqual([204, 204, 204]);
      expect(contractorTables.contractors).toHaveLength(0);
      expect(audits("contractor.delete")).toHaveLength(3);
    });

    it("a stale update and a delete at the same time: one of them wins, never both", async () => {
      const row = seed();

      const [patch, del] = await Promise.all([
        call("patch", `/contractors/${row.id}`, { body: { name: "Edited" }, ifMatch: "1" }),
        call("delete", `/contractors/${row.id}`, { ifMatch: "1" }),
      ]);

      // Whichever commits first wins. If it was the delete, the update then finds nothing (404); if it was the update,
      // the delete is refused as stale (409).
      expect([patch.status, del.status].filter((status) => status === 200 || status === 204)).toHaveLength(1);
      expect([patch.status, del.status].filter((status) => status === 409 || status === 404)).toHaveLength(1);
      expect(contractorTables.contractors).toHaveLength(patch.status === 200 ? 1 : 0);
    });
  });

  it("rolls the version back with the rest when the audit entry cannot be written", async () => {
    const row = seed();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await call("patch", `/contractors/${row.id}`, { body: { name: "Never" } });

    expect(res.status).toBe(500);
    expect(contractorTables.contractors[0]).toMatchObject({ name: "Nile Builders", version: 1 });
  });
});

describe("a write that loses the race between the lock and the update is 409, never a silent overwrite", () => {
  const seedVilla = () => addVilla({ civilEngineerId: addEngineer({ name: "Mona Hassan" }).id });
  const user = () => store.addUser({ name: "Sara", email: "sara@example.test", passwordHash: "x" });

  it("civil engineer update and delete", async () => {
    const engineer = addEngineer({ name: "Mona Hassan" });
    vi.spyOn(InMemoryCivilEngineersRepository.prototype, "update").mockResolvedValueOnce(null);
    vi.spyOn(InMemoryCivilEngineersRepository.prototype, "delete").mockResolvedValueOnce(false);

    conflict(await call("patch", `/civil-engineers/${engineer.id}`, { body: { name: "X" } }), 1);
    conflict(await call("delete", `/civil-engineers/${engineer.id}`), 1);

    expect(engineerTables.engineers).toHaveLength(1);
    expect(audits("civil_engineer.update")).toHaveLength(0);
    expect(audits("civil_engineer.delete")).toHaveLength(0);
  });

  it("contractor delete", async () => {
    const row = addContractor({ name: "Nile Builders" });
    vi.spyOn(InMemoryContractorsRepository.prototype, "delete").mockResolvedValueOnce(false);

    conflict(await call("delete", `/contractors/${row.id}`), 1);

    expect(contractorTables.contractors).toHaveLength(1);
    expect(audits("contractor.delete")).toHaveLength(0);
  });

  it("villa update changes nothing and writes no audit entry; villa delete leaves the villa", async () => {
    const villa = seedVilla();
    const con = addContractor({ name: "Contractor A" });
    vi.spyOn(InMemoryVillasRepository.prototype, "updateScalars").mockResolvedValueOnce(false);
    vi.spyOn(InMemoryVillasRepository.prototype, "delete").mockResolvedValueOnce(false);

    conflict(await call("patch", `/villas/${villa.id}`, { body: { contractorId: con.id, block: "B9" } }), 1);
    conflict(await call("delete", `/villas/${villa.id}`), 1);

    expect(villaTables.villas[0]?.contractorId).toBeNull();
    expect(villaTables.villas[0]?.block).not.toBe("B9");
    expect(villaTables.villas).toHaveLength(1);
    expect(audits("villa.update")).toHaveLength(0);
  });

  it("user update, activate and deactivate (and a deactivate signs nobody out)", async () => {
    const sara = user();
    store.refreshTokens.push({
      id: randomUUID(),
      userId: sara.id,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      replacedById: null,
      createdAt: new Date(),
    });
    vi.spyOn(InMemoryUsersRepository.prototype, "updateUser").mockResolvedValueOnce(null);
    vi.spyOn(InMemoryUsersRepository.prototype, "setActive").mockResolvedValue(null);

    conflict(await call("patch", `/users/${sara.id}`, { body: { name: "X" } }), 1);
    conflict(await call("patch", `/users/${sara.id}/activate`), 1);
    conflict(await call("patch", `/users/${sara.id}/deactivate`), 1);

    expect(store.refreshTokens[0]?.revokedAt).toBeNull();
    expect(store.users.find((u) => u.id === sara.id)).toMatchObject({
      name: "Sara",
      isActive: true,
      version: 1,
    });
    expect(audits("user.update")).toHaveLength(0);
    expect(audits("user.deactivate")).toHaveLength(0);
  });
});

describe("civil engineers", () => {
  it("goes up with every update, refuses a stale If-Match, and the same for DELETE", async () => {
    const engineer = addEngineer({ name: "Mona Hassan" });

    const ok = await call("patch", `/civil-engineers/${engineer.id}`, {
      body: { name: "Mona H." },
      ifMatch: "1",
    });
    const stale = await call("patch", `/civil-engineers/${engineer.id}`, {
      body: { name: "Other" },
      ifMatch: "1",
    });
    const staleDelete = await call("delete", `/civil-engineers/${engineer.id}`, { ifMatch: "1" });
    const single = await call("get", `/civil-engineers/${engineer.id}`);
    const deleted = await call("delete", `/civil-engineers/${engineer.id}`, { ifMatch: "2" });

    expect(ok.body.data.version).toBe(2);
    conflict(stale, 2);
    conflict(staleDelete, 2);
    expect(single.headers["etag"]).toBe('"2"');
    expect(single.headers["cache-control"]).toBe("private, no-store");
    expect(single.body.data.version).toBe(2);
    expect(deleted.status).toBe(204);
  });

  it("two simultaneous updates with the same version: one wins", async () => {
    const engineer = addEngineer({ name: "Mona Hassan" });

    const [a, b] = await Promise.all([
      call("patch", `/civil-engineers/${engineer.id}`, { body: { phone: "0100 111 1111" }, ifMatch: "1" }),
      call("patch", `/civil-engineers/${engineer.id}`, { body: { phone: "0100 222 2222" }, ifMatch: "1" }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(engineerTables.engineers[0]?.version).toBe(2);
  });

  it("a plain update without If-Match still works and counts", async () => {
    const engineer = addEngineer({ name: "Mona Hassan" });

    await call("patch", `/civil-engineers/${engineer.id}`, { body: { name: "One" } });
    await call("patch", `/civil-engineers/${engineer.id}`, { body: { name: "Two" } });

    expect(engineerTables.engineers[0]?.version).toBe(3);
  });
});

describe("villas", () => {
  const seed = () => {
    const engineer = addEngineer({ name: "Mona Hassan" });
    const conA = addContractor({ name: "Contractor A" });
    const conB = addContractor({ name: "Contractor B" });
    const villa = addVilla({ civilEngineerId: engineer.id });
    return { engineer, conA, conB, villa };
  };

  it("shows the version in the list item, the detail and (as ETag) the single villa", async () => {
    const { villa } = seed();

    const detail = await call("get", `/villas/${villa.id}`);
    const list = await call("get", "/villas");

    expect(detail.body.data.version).toBe(1);
    expect(detail.headers["etag"]).toBe('"1"');
    expect(detail.headers["cache-control"]).toBe("private, no-store");
    expect(list.body.data[0].version).toBe(1);
  });

  it("an update goes up by one and is refused when stale", async () => {
    const { villa } = seed();

    const ok = await call("patch", `/villas/${villa.id}`, { body: { block: "B2" }, ifMatch: "1" });
    const stale = await call("patch", `/villas/${villa.id}`, { body: { block: "B3" }, ifMatch: "1" });

    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ block: "B2", version: 2 });
    expect(ok.headers["etag"]).toBe('"2"');
    expect(ok.headers["cache-control"]).toBe("private, no-store");
    conflict(stale, 2);
    expect(villaTables.villas[0]?.block).toBe("B2");
  });

  it("changing only the contractor still moves the version", async () => {
    const { villa, conA } = seed();

    const res = await call("patch", `/villas/${villa.id}`, { body: { contractorId: conA.id } });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(villaTables.villas[0]?.contractorId).toBe(conA.id);
  });

  it("a stale update changes nothing at all, the contractor included", async () => {
    const { villa, conA, conB } = seed();
    await call("patch", `/villas/${villa.id}`, { body: { contractorId: conA.id } });

    const elsewhere = addArea({ name: "Elsewhere" });
    const stale = await call("patch", `/villas/${villa.id}`, {
      body: { contractorId: conB.id, areaId: elsewhere.id },
      ifMatch: "1",
    });

    conflict(stale, 2);
    expect(villaTables.villas[0]?.contractorId).toBe(conA.id);
    expect(villaTables.villas[0]?.areaId).not.toBe(elsewhere.id);
    expect(audits("villa.update")).toHaveLength(1);
  });

  it("two simultaneous updates with the same version: one wins, and the winner's contractor is the one set", async () => {
    const { villa, conA, conB } = seed();

    const [a, b] = await Promise.all([
      call("patch", `/villas/${villa.id}`, { body: { contractorId: conA.id }, ifMatch: "1" }),
      call("patch", `/villas/${villa.id}`, { body: { contractorId: conB.id }, ifMatch: "1" }),
    ]);

    const winner = [a, b].findIndex((res) => res.status === 200);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(villaTables.villas[0]?.version).toBe(2);
    expect(villaTables.villas[0]?.contractorId).toBe([conA.id, conB.id][winner]);
  });

  it("without If-Match, simultaneous updates both apply in turn and the audit entries chain", async () => {
    const { villa } = seed();

    const [areaOne, areaTwo] = [addArea({ name: "Area One" }), addArea({ name: "Area Two" })];
    const [a, b] = await Promise.all([
      call("patch", `/villas/${villa.id}`, { body: { areaId: areaOne.id } }),
      call("patch", `/villas/${villa.id}`, { body: { areaId: areaTwo.id } }),
    ]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(villaTables.villas[0]?.version).toBe(3);
    const [first, second] = audits("villa.update") as unknown as {
      before: { areaId: string };
      after: { areaId: string };
    }[];
    expect(second?.before.areaId).toBe(first?.after.areaId);
  });

  it("DELETE is refused when stale and the villa stays; with the current version it goes", async () => {
    const { villa } = seed();
    await call("patch", `/villas/${villa.id}`, { body: { areaId: addArea({ name: "Moved" }).id } });

    const stale = await call("delete", `/villas/${villa.id}`, { ifMatch: "1" });
    const gone = await call("delete", `/villas/${villa.id}`, { ifMatch: "2" });

    conflict(stale, 2);
    expect(gone.status).toBe(204);
    expect(villaTables.villas).toHaveLength(0);
  });

  it("is 404 for an unknown villa, and a stale version does not hide it", async () => {
    const res = await call("patch", `/villas/${MISSING}`, { body: { block: "B2" }, ifMatch: "3" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("VILLA_NOT_FOUND");
  });
});

describe("a password change moves the user's version", () => {
  it("so an administrator's edit made on the older record is refused", async () => {
    const { default: bcrypt } = await import("bcrypt");
    const passwordHash = await bcrypt.hash("Old-Password-1", 4);
    const sara = store.addUser({ name: "Sara", email: "sara@example.test", passwordHash });

    const changed = await request(app)
      .post("/api/v1/auth/change-password")
      .set({ Authorization: `Bearer ${await signAccessToken({ id: sara.id, role: sara.role })}` })
      .send({ currentPassword: "Old-Password-1", newPassword: "Brand-New-Pass-1" });
    const stale = await call("patch", `/users/${sara.id}`, { body: { name: "Admin Edit" }, ifMatch: "1" });

    expect(changed.status).toBe(200);
    expect(store.users.find((u) => u.id === sara.id)?.version).toBe(2);
    conflict(stale, 2);
  });
});

describe("users", () => {
  const employee = (email = "sara@example.test") => store.addUser({ name: "Sara", email, passwordHash: "x" });

  it("shows the version in the item and the list, and an ETag on the single user", async () => {
    const user = employee();

    const single = await call("get", `/users/${user.id}`);
    const list = await call("get", "/users");

    expect(single.body.data.version).toBe(1);
    expect(single.headers["etag"]).toBe('"1"');
    expect(single.headers["cache-control"]).toBe("private, no-store");
    expect(list.body.data.every((item: { version: number }) => item.version === 1)).toBe(true);
  });

  it("update: goes up by one, refuses a stale version, and two at once leave one winner", async () => {
    const user = employee();

    const ok = await call("patch", `/users/${user.id}`, { body: { name: "Sara K" }, ifMatch: "1" });
    const stale = await call("patch", `/users/${user.id}`, { body: { name: "Sara Q" }, ifMatch: "1" });

    expect(ok.body.data.version).toBe(2);
    expect(ok.headers["etag"]).toBe('"2"');
    conflict(stale, 2);

    const [a, b] = await Promise.all([
      call("patch", `/users/${user.id}`, { body: { name: "A" }, ifMatch: "2" }),
      call("patch", `/users/${user.id}`, { body: { name: "B" }, ifMatch: "2" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(store.users.find((u) => u.id === user.id)?.version).toBe(3);
  });

  it("activate and deactivate move the version and honour If-Match; a stale deactivate signs nobody out", async () => {
    const user = employee();
    store.refreshTokens.push({
      id: randomUUID(),
      userId: user.id,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: null,
      replacedById: null,
      createdAt: new Date(),
    });

    const stale = await call("patch", `/users/${user.id}/deactivate`, { ifMatch: "5" });
    conflict(stale, 1);
    expect(store.users.find((u) => u.id === user.id)?.isActive).toBe(true);
    expect(store.refreshTokens[0]?.revokedAt).toBeNull();

    const off = await call("patch", `/users/${user.id}/deactivate`, { ifMatch: "1" });
    const staleOn = await call("patch", `/users/${user.id}/activate`, { ifMatch: "1" });
    const on = await call("patch", `/users/${user.id}/activate`, { ifMatch: "2" });

    expect(off.body.data).toMatchObject({ isActive: false, version: 2 });
    expect(off.headers["etag"]).toBe('"2"');
    conflict(staleOn, 2);
    expect(on.body.data).toMatchObject({ isActive: true, version: 3 });
  });

  it("works without If-Match", async () => {
    const user = employee();

    expect((await call("patch", `/users/${user.id}`, { body: { name: "Plain" } })).status).toBe(200);
    expect((await call("patch", `/users/${user.id}/deactivate`)).status).toBe(200);
    expect(store.users.find((u) => u.id === user.id)?.version).toBe(3);
  });

  it("is 404 for an unknown user", async () => {
    expect((await call("patch", `/users/${MISSING}`, { body: { name: "X" }, ifMatch: "1" })).status).toBe(
      404,
    );
  });

  it("the user's own profile and password changes move the version too, so an administrator's stale edit is refused", async () => {
    const user = employee();
    const token = await signAccessToken({ id: user.id, role: user.role });

    await request(app)
      .patch("/api/v1/me")
      .set({ Authorization: `Bearer ${token}` })
      .send({ name: "Sara Renamed" });
    const stale = await call("patch", `/users/${user.id}`, { body: { name: "Admin Edit" }, ifMatch: "1" });

    conflict(stale, 2);
  });
});
