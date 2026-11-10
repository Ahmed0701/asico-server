import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { RecordingMailer } from "../auth/recording-mailer.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import {
  InMemoryContractorsRepository,
  contractorTables,
} from "../contractors/in-memory-contractors.repository.js";
import { permissionTable } from "../permissions/in-memory-permissions.repository.js";
import { areaNamed, villaTables } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "./in-memory-idempotency.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("./in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
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
import { setMailer } from "../../../src/core/mail/index.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const KEY = "0b7e3c1e-5d52-4f0e-9a1d-6a3f2c9b7d11";
const mailbox = new RecordingMailer();

let admin: User;
beforeEach(() => {
  store.reset();
  contractorTables.reset();
  engineerTables.reset();
  villaTables.reset();
  permissionTable.reset();
  idempotencyTable.reset();
  mailbox.reset();
  setMailer(mailbox);
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMailer(undefined);
});

const bearer = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

type Send = { key?: string | undefined; user?: User; language?: string; query?: string };
async function post(path: string, body: unknown, options: Send = {}) {
  const req = request(app)
    .post(`/api/v1${path}${options.query ?? ""}`)
    .set(await bearer(options.user ?? admin))
    .set("Accept-Language", options.language ?? "en");
  const key = "key" in options ? options.key : KEY;
  if (key !== undefined) {
    req.set("Idempotency-Key", key);
  }
  return req.send(body as object);
}

// Holds a contractor write before it starts, so a request can be caught half way through. The hold is taken before the
// transaction (which the fakes serialize), so other requests are not stuck behind it.
function holdContractorCreate() {
  let release!: () => void;
  let entered!: () => void;
  const open = new Promise<void>((resolve) => (release = resolve));
  const reached = new Promise<void>((resolve) => (entered = resolve));
  const original = InMemoryContractorsRepository.prototype.transaction;
  const spy = vi
    .spyOn(InMemoryContractorsRepository.prototype, "transaction")
    .mockImplementationOnce(async function (this: InMemoryContractorsRepository, work) {
      entered();
      await open;
      return original.call(this, work);
    });
  return { release, reached, spy };
}

const contractor = { name: "Nile Builders", phone: "0100 123 4567" };
const rows = () => idempotencyTable.rows;

describe("an Idempotency-Key on POST", () => {
  it("runs the request once and replays the stored response for the same key and the same request", async () => {
    const create = vi.spyOn(InMemoryContractorsRepository.prototype, "create");

    const first = await post("/contractors", contractor);
    const second = await post("/contractors", contractor);

    expect(first.status).toBe(201);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(create).toHaveBeenCalledTimes(1);
    expect(contractorTables.contractors).toHaveLength(1);
    // Nothing ran the second time, so nothing was audited the second time either.
    expect(store.auditRows).toHaveLength(1);
  });

  it("keeps replaying it as often as asked, and the replay carries its own request id", async () => {
    const first = await post("/contractors", contractor);

    const replays = [await post("/contractors", contractor), await post("/contractors", contractor)];

    for (const replay of replays) {
      expect(replay.body).toEqual(first.body);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.headers["x-request-id"]).toEqual(expect.any(String));
    }
    expect(replays[0]?.headers["x-request-id"]).not.toBe(first.headers["x-request-id"]);
    expect(contractorTables.contractors).toHaveLength(1);
  });

  it("is the same request whatever the order of the keys in the body", async () => {
    await post("/contractors", { name: "Nile Builders", phone: "0100 123 4567" });

    const again = await post("/contractors", { phone: "0100 123 4567", name: "Nile Builders" });

    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(contractorTables.contractors).toHaveLength(1);
  });

  it("two simultaneous identical requests create one record", async () => {
    const [a, b] = await Promise.all([post("/contractors", contractor), post("/contractors", contractor)]);

    expect(contractorTables.contractors).toHaveLength(1);
    const statuses = [a.status, b.status].sort();
    // One ran. The other either found it still running (409) or arrived after it finished (a replay).
    expect(statuses[0] === 201 && (statuses[1] === 201 || statuses[1] === 409)).toBe(true);
    for (const res of [a, b]) {
      if (res.status === 409) expect(res.body.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    }
    expect(rows().filter((row) => row.status === "COMPLETED")).toHaveLength(1);
  });

  it("many simultaneous identical requests still create exactly one", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => post("/contractors", contractor)));

    expect(contractorTables.contractors).toHaveLength(1);
    expect(results.filter((res) => res.status === 201 && !res.headers["idempotent-replayed"])).toHaveLength(
      1,
    );
    expect(results.every((res) => res.status === 201 || res.status === 409)).toBe(true);
  });

  it("answers 409 IDEMPOTENCY_IN_PROGRESS, with Retry-After, while the first is still running; then it is a replay", async () => {
    const gate = holdContractorCreate();
    const first = post("/contractors", contractor);
    await gate.reached;

    const during = await post("/contractors", contractor, { language: "ar" });
    gate.release();
    const finished = await first;
    const after = await post("/contractors", contractor);

    expect(during.status).toBe(409);
    expect(during.body.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(during.body.message).toBe(
      "لا يزال الطلب ذو مفتاح Idempotency-Key هذا قيد المعالجة. يرجى المحاولة بعد لحظات",
    );
    expect(during.headers["retry-after"]).toBe("1");
    expect(finished.status).toBe(201);
    expect(after.status).toBe(201);
    expect(after.headers["idempotent-replayed"]).toBe("true");
    expect(after.body).toEqual(finished.body);
    expect(contractorTables.contractors).toHaveLength(1);
  });

  it("answers 422 IDEMPOTENCY_KEY_REUSED for the same key with a different request, and does nothing", async () => {
    await post("/contractors", contractor);

    const other = await post(
      "/contractors",
      { ...contractor, name: "Delta Contracting" },
      { language: "ar" },
    );

    expect(other.status).toBe(422);
    expect(other.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(other.body.message).toBe("تم استخدام مفتاح Idempotency-Key هذا مسبقًا لطلب مختلف");
    expect(contractorTables.contractors).toHaveLength(1);
    // The stored result is still the first one.
    const replay = await post("/contractors", contractor);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
  });

  it("answers 422 for the same key on another endpoint, and for another query string", async () => {
    await post("/contractors", contractor);

    const elsewhere = await post("/civil-engineers", contractor);
    const queried = await post("/contractors", contractor, { query: "?x=1" });

    expect(elsewhere.status).toBe(422);
    expect(queried.status).toBe(422);
    expect(engineerTables.engineers).toHaveLength(0);
    expect(contractorTables.contractors).toHaveLength(1);
  });

  it("answers 422 even while the first request is still running, if the request differs", async () => {
    const gate = holdContractorCreate();
    const first = post("/contractors", contractor);
    await gate.reached;

    const other = await post("/contractors", { ...contractor, phone: "0100 000 0000" });
    gate.release();
    await first;

    expect(other.status).toBe(422);
    expect(contractorTables.contractors).toHaveLength(1);
  });

  describe("only a successful response is kept", () => {
    it("does not store a 5xx: the same key can be retried, and then it runs", async () => {
      vi.spyOn(logger, "error").mockImplementation(() => undefined);
      vi.spyOn(InMemoryContractorsRepository.prototype, "create").mockRejectedValueOnce(new Error("db down"));

      const failed = await post("/contractors", contractor);
      expect(failed.status).toBe(500);
      expect(rows()).toHaveLength(0);

      const retried = await post("/contractors", contractor);
      expect(retried.status).toBe(201);
      expect(retried.headers["idempotent-replayed"]).toBeUndefined();
      expect(contractorTables.contractors).toHaveLength(1);
      expect(rows().map((row) => row.status)).toEqual(["COMPLETED"]);
    });

    it("does not store a 4xx either: the key is given back, and a corrected request with it runs", async () => {
      const unknownEngineer = randomUUID();
      const body = {
        villaNumber: "P-001",
        areaId: areaNamed("New Cairo"),
        block: "B1",
        plot: "7",
        civilEngineerId: unknownEngineer,
      };

      const refused = await post("/villas", body);
      expect(refused.status).toBe(404);
      expect(rows()).toHaveLength(0);

      const engineer = addEngineer({ name: "Mona Hassan" });
      const accepted = await post("/villas", { ...body, civilEngineerId: engineer.id });
      expect(accepted.status).toBe(201);
      expect(accepted.headers["idempotent-replayed"]).toBeUndefined();
    });

    it("a request that would run twice with the same key after a failure never ends in two records", async () => {
      vi.spyOn(logger, "error").mockImplementation(() => undefined);
      vi.spyOn(InMemoryContractorsRepository.prototype, "create").mockRejectedValueOnce(new Error("db down"));

      const results = [
        await post("/contractors", contractor),
        await post("/contractors", contractor),
        await post("/contractors", contractor),
      ];

      expect(results.map((res) => res.status)).toEqual([500, 201, 201]);
      expect(contractorTables.contractors).toHaveLength(1);
    });

    it("gives the key back when the response cannot be stored, and still answers the client", async () => {
      vi.spyOn(logger, "error").mockImplementation(() => undefined);
      idempotencyTable.failComplete = true;

      const res = await post("/contractors", contractor);

      expect(res.status).toBe(201);
      expect(rows()).toHaveLength(0);
    });
  });

  describe("keys are per user", () => {
    it("the same key from two users is two requests, each replayed to its own user", async () => {
      const other = store.addUser({ name: "Other Admin", email: "o@example.test", passwordHash: "x" });
      store.grant(other.id, "contractors:create");

      const mine = await post("/contractors", contractor);
      const theirs = await post("/contractors", contractor, { user: other });
      const mineAgain = await post("/contractors", contractor);
      const theirsAgain = await post("/contractors", contractor, { user: other });

      expect(contractorTables.contractors).toHaveLength(2);
      expect(theirs.body.data.id).not.toBe(mine.body.data.id);
      expect(mineAgain.body).toEqual(mine.body);
      expect(theirsAgain.body).toEqual(theirs.body);
      expect(
        rows()
          .map((row) => row.userId)
          .sort(),
      ).toEqual([admin.id, other.id].sort());
    });

    it("another user cannot replay, or even see, what a key holds", async () => {
      const other = store.addUser({ name: "Other Admin", email: "o@example.test", passwordHash: "x" });
      store.grant(other.id, "contractors:create");
      await post("/contractors", contractor);

      const theirs = await post("/contractors", { ...contractor, name: "Someone Else" }, { user: other });

      expect(theirs.status).toBe(201);
      expect(theirs.headers["idempotent-replayed"]).toBeUndefined();
    });
  });

  describe("the key itself", () => {
    it("is optional: without it every request runs", async () => {
      await post("/contractors", contractor, { key: undefined });
      await post("/contractors", contractor, { key: undefined });

      expect(contractorTables.contractors).toHaveLength(2);
      expect(rows()).toHaveLength(0);
    });

    it.each([
      ["too short", "abc123"],
      ["with a space", "has a space inside"],
      ["with a slash", "path/like/key/12345"],
      ["with markup", "<script>alert(1)</script>"],
      ["not ASCII", "clé-élevée-123456"],
      ["too long", "a".repeat(256)],
    ])("is refused (400) when it is %s, before anything runs", async (_label, key) => {
      const res = await post("/contractors", contractor, { key, language: "ar" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_IDEMPOTENCY_KEY");
      expect(contractorTables.contractors).toHaveLength(0);
    });

    it.each(["12345678", "a".repeat(255), "0b7e3c1e-5d52-4f0e-9a1d-6a3f2c9b7d11", "order.2026:10-12_A"])(
      "accepts %j",
      async (key) => {
        const res = await post("/contractors", contractor, { key });

        expect(res.status).toBe(201);
      },
    );

    it("is ignored on routes that do not use it, and on reads", async () => {
      const read = await request(app)
        .get("/api/v1/contractors")
        .set(await bearer(admin))
        .set("Idempotency-Key", KEY);

      expect(read.status).toBe(200);
      expect(rows()).toHaveLength(0);
    });

    it("is only looked at after authentication, validation and the permission check", async () => {
      const anonymous = await request(app)
        .post("/api/v1/contractors")
        .set("Idempotency-Key", KEY)
        .send(contractor);
      const invalid = await post("/contractors", { name: "" });
      const nobody = store.addUser({ name: "No Rights", email: "n@example.test", passwordHash: "x" });
      const forbidden = await post("/contractors", contractor, { user: nobody });

      expect([anonymous.status, invalid.status, forbidden.status]).toEqual([401, 400, 403]);
      expect(rows()).toHaveLength(0);
    });
  });

  describe("what is stored", () => {
    it("is a hash of the request and the response, never the request itself", async () => {
      await post("/contractors", { name: "Distinctive Name 4711", phone: "0100 555 7777" });

      const [row] = rows();
      // Everything but the response, which the client has received anyway.
      const everything = JSON.stringify({ ...row, responseBody: undefined });
      expect(row).toMatchObject({
        key: KEY,
        userId: admin.id,
        method: "POST",
        path: "/api/v1/contractors",
        status: "COMPLETED",
        responseStatus: 201,
      });
      expect(row?.requestHash).toMatch(/^[0-9a-f]{64}$/);
      expect(everything).not.toContain("0100 555 7777");
      expect(everything).not.toContain("Distinctive Name 4711");
      expect(JSON.stringify(row?.responseBody)).toContain("Distinctive Name 4711");
      expect(Object.keys(row ?? {}).sort()).toEqual(
        [
          "createdAt",
          "expiresAt",
          "id",
          "key",
          "method",
          "path",
          "requestHash",
          "responseBody",
          "responseStatus",
          "status",
          "userId",
        ].sort(),
      );
    });

    it("holds no password: creating a user stores a hash, and a response without any password field", async () => {
      const res = await post("/users", {
        name: "New Person",
        email: "new@example.test",
        password: "Sup3r-Secret-Pass!",
        isActive: true,
      });

      expect(res.status).toBe(201);
      const [row] = rows();
      const everything = JSON.stringify(row);
      expect(everything).not.toContain("Sup3r-Secret-Pass!");
      expect(everything).not.toMatch(/passwordHash|\$2[aby]\$/);
      expect(row?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is not a plain hash of the body: the same body from the same user under another key hashes alike, but not to a bare digest", async () => {
      await post("/contractors", contractor, { key: "key-number-0001" });
      await post("/contractors", contractor, { key: "key-number-0002" });

      const [first, second] = rows();
      expect(first?.requestHash).toBe(second?.requestHash);
      const { createHash } = await import("node:crypto");
      const bare = createHash("sha256")
        .update(JSON.stringify(["POST", "/api/v1/contractors", contractor, null]))
        .digest("hex");
      expect(first?.requestHash).not.toBe(bare);
    });

    it("is not used for /auth routes: a key on a login stores nothing", async () => {
      const login = await request(app)
        .post("/api/v1/auth/login")
        .set("Idempotency-Key", KEY)
        .send({ email: "root@example.test", password: "wrong-password-1" });

      expect(login.status).toBe(401);
      expect(rows()).toHaveLength(0);
      for (const path of ["/auth/refresh", "/auth/logout", "/auth/forgot-password", "/auth/signup"]) {
        await request(app).post(`/api/v1${path}`).set("Idempotency-Key", KEY).send({});
      }
      expect(rows()).toHaveLength(0);
    });
  });

  describe("time", () => {
    it("a stored response is replayed for 24 hours and then the key is free again", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T10:00:00.000Z") });
      await post("/contractors", contractor);

      vi.setSystemTime(new Date("2026-10-15T09:59:59.000Z"));
      const inside = await post("/contractors", contractor);
      vi.setSystemTime(new Date("2026-10-15T10:00:01.000Z"));
      const outside = await post("/contractors", contractor);

      expect(inside.headers["idempotent-replayed"]).toBe("true");
      expect(outside.status).toBe(201);
      expect(outside.headers["idempotent-replayed"]).toBeUndefined();
      expect(contractorTables.contractors).toHaveLength(2);
      expect(rows()).toHaveLength(1);
    });

    it("a request that never finished blocks its key for 2 minutes, and then the key can be taken over", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T10:00:00.000Z") });
      const gate = holdContractorCreate();
      const abandoned = post("/contractors", contractor);
      await gate.reached;

      vi.setSystemTime(new Date("2026-10-14T10:01:59.000Z"));
      const tooSoon = await post("/contractors", contractor);
      vi.setSystemTime(new Date("2026-10-14T10:02:00.000Z"));
      const takenOver = await post("/contractors", contractor);

      expect(tooSoon.status).toBe(409);
      expect(takenOver.status).toBe(201);
      expect(takenOver.headers["idempotent-replayed"]).toBeUndefined();
      gate.release();
      const late = await abandoned;
      expect(late.status).toBe(201);
    });

    it("the request that lost its claim to a takeover cannot overwrite the new owner's stored result", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-14T10:00:00.000Z") });
      const gate = holdContractorCreate();
      const slow = post("/contractors", contractor);
      await gate.reached;
      vi.setSystemTime(new Date("2026-10-14T10:03:00.000Z"));
      const takeover = await post("/contractors", contractor);

      gate.release();
      await slow;

      const replay = await post("/contractors", contractor);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
      expect(replay.body).toEqual(takeover.body);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]?.status).toBe("COMPLETED");
    });
  });

  it("stores the answer before sending it, however long storing takes: a client that retries at once is never told 'in progress'", async () => {
    idempotencyTable.completeDelayMs = 60;
    for (let i = 0; i < 3; i++) {
      const key = `slow-store-${String(i).padStart(4, "0")}`;
      const body = { name: `Slow ${i}`, phone: "0100 123 4567" };

      const first = await post("/contractors", body, { key });
      const again = await post("/contractors", body, { key });

      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
    }
    expect(contractorTables.contractors).toHaveLength(3);
  });

  it("is settled before the response goes out: a client that retries at once never sees 'in progress'", async () => {
    for (let i = 0; i < 15; i++) {
      const key = `rapid-retry-${String(i).padStart(4, "0")}`;
      const body = { name: `Contractor ${i}`, phone: "0100 123 4567" };
      const first = await post("/contractors", body, { key });
      const again = await post("/contractors", body, { key });

      expect(first.status).toBe(201);
      expect(again.status).toBe(201);
      expect(again.headers["idempotent-replayed"]).toBe("true");
    }
    expect(contractorTables.contractors).toHaveLength(15);
  });
});

describe("every covered endpoint replays instead of running twice", () => {
  it("POST /civil-engineers", async () => {
    const body = { name: "Mona Hassan", phone: "0100 123 4567" };
    const first = await post("/civil-engineers", body);
    const second = await post("/civil-engineers", body);

    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(engineerTables.engineers).toHaveLength(1);
  });

  it("POST /villas", async () => {
    const engineer = addEngineer({ name: "Mona Hassan" });
    const body = {
      villaNumber: "P-001",
      areaId: areaNamed("New Cairo"),
      block: "B1",
      plot: "7",
      civilEngineerId: engineer.id,
    };
    const first = await post("/villas", body);
    const second = await post("/villas", body);

    expect(first.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(villaTables.villas).toHaveLength(1);
    expect(second.body.data.version).toBe(1);
  });

  it("POST /users creates one user, and a replay does not hit the unique email", async () => {
    const body = {
      name: "New Person",
      email: "new@example.test",
      password: "Sup3r-Secret-Pass!",
      isActive: true,
    };
    const first = await post("/users", body);
    const second = await post("/users", body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(store.users.filter((user) => user.email === "new@example.test")).toHaveLength(1);
  });

  it("POST /users/:id/reset-password sends one email and signs the user out once", async () => {
    const user = store.addUser({ name: "Sara", email: "sara@example.test", passwordHash: "x" });

    const first = await post(`/users/${user.id}/reset-password`, {});
    const second = await post(`/users/${user.id}/reset-password`, {});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(mailbox.sent).toHaveLength(1);
    expect(store.resetTokens).toHaveLength(1);
    expect(store.auditRows.filter((row) => row.action === "user.password_reset_issued")).toHaveLength(1);
  });
});
