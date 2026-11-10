import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import {
  addStartingPhases,
  phaseTables,
  type StoredPhase,
} from "../elec-phases/in-memory-elec-phases.repository.js";
import { addVilla, areaNamed, villaTables, type StoredVilla } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { InMemoryVillaProgressRepository, progressTables } from "./in-memory-villa-progress.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock(
  "../../../src/modules/villa-progress/repository/villa-progress.repository.js",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/modules/villa-progress/repository/villa-progress.repository.js")
    >()),
    VillaProgressRepository: (await import("./in-memory-villa-progress.repository.js"))
      .InMemoryVillaProgressRepository,
  }),
);
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock("../../../src/modules/elec-phases/repository/elec-phases.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/elec-phases/repository/elec-phases.repository.js")
  >()),
  ElecPhasesRepository: (await import("../elec-phases/in-memory-elec-phases.repository.js"))
    .InMemoryElecPhasesRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { progressChangeHooks } from "../../../src/modules/villa-progress/index.js";
import {
  mirrorProgressToOpenWorks,
  setPhaseOpenWork,
  workItemTables,
} from "../open-works/work-item-tables.js";

const app = createApp();
const MISSING_ID = randomUUID();
const KEY = "0b7e3c1e-5d52-4f0e-9a1d-6a3f2c9b7d11";

let admin: User;
let villa: StoredVilla;
let phases: StoredPhase[];

// Every villa and phase gets its row at 0, as creating them through the API does.
function seedRows(): void {
  progressTables.insertMissing(
    villaTables.villas.flatMap((v) => phaseTables.phases.map((p) => ({ villaId: v.id, elecPhaseId: p.id }))),
  );
}

beforeEach(() => {
  // A PATCH of a phase's progress reaches the villa's open works, as the app's sync does.
  progressChangeHooks.length = 0;
  progressChangeHooks.push(mirrorProgressToOpenWorks);
  store.reset();
  engineerTables.reset();
  villaTables.reset();
  phaseTables.reset();
  idempotencyTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  addEngineer({ name: "Mona Hassan" });
  phases = addStartingPhases();
  // What each phase adds to a villa once its open work is done: 20, 20, 15, 15, 15, 15 (100 in all).
  phases.forEach((phase, index) => {
    phase.progressRatio = index < 2 ? 20 : 15;
  });
  villa = addVilla({ villaNumber: "P-001" });
  seedRows();
});
afterEach(() => {
  vi.restoreAllMocks();
  progressChangeHooks.length = 0;
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

type Verb = "get" | "post" | "patch" | "delete";
type Options = { language?: string; body?: unknown; ifMatch?: string; key?: string; user?: User };
const send = async (verb: Verb, path: string, options: Options = {}) => {
  const agent = request(app);
  const req = agent[verb](`/api/v1${path}`)
    .set(await as(options.user ?? admin))
    .set("Accept-Language", options.language ?? "en");
  if (options.ifMatch !== undefined) req.set("If-Match", options.ifMatch);
  if (options.key !== undefined) req.set("Idempotency-Key", options.key);
  return options.body === undefined ? req : req.send(options.body as object);
};

const first = (): StoredPhase => phases[0]!;
const second = (): StoredPhase => phases[1]!;
const pathOf = (phase: StoredPhase = first(), v: StoredVilla = villa): string =>
  `/villas/${v.id}/phases/${phase.id}`;
const patch = (progress: unknown, options: Options = {}, phase?: StoredPhase, v?: StoredVilla) =>
  send("patch", pathOf(phase, v), { body: { progress }, ...options });
const rowOf = (phase: StoredPhase = first(), v: StoredVilla = villa) => progressTables.find(v.id, phase.id)!;
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const conflict = (res: request.Response, current: number) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("VERSION_CONFLICT");
  expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: current }]);
};

describe("access control", () => {
  it("requires authentication (401)", async () => {
    const res = await request(app).patch(`/api/v1${pathOf()}`).send({ progress: 5 });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("answers 403 to an employee with no permissions, in Arabic on request", async () => {
    const res = await patch(5, { user: employee("e@example.test"), language: "ar" });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    expect(rowOf().progress).toBe(0);
  });

  it("is not opened by the villas' other permissions", async () => {
    const user = employee(
      "e@example.test",
      "villas:read",
      "villas:detail",
      "villas:create",
      "villas:update",
      "villas:delete",
      "villas:export",
      "elec-phases:update",
    );

    expect((await patch(5, { user })).status).toBe(403);
    expect(rowOf().progress).toBe(0);
  });

  it("lets an employee with villas:progress update, and an admin without any grant", async () => {
    const user = employee("e@example.test", "villas:progress");

    expect((await patch(5, { user })).status).toBe(200);
    expect((await patch(6)).status).toBe(200);
  });

  it("checks the permission before the ids and the body (a caller without it learns nothing)", async () => {
    const user = employee("e@example.test");

    const res = await send("patch", "/villas/not-a-uuid/phases/also-not", { user, body: { progress: "x" } });

    expect(res.status).toBe(403);
  });
});

describe("PATCH /villas/:villaId/phases/:elecPhaseId", () => {
  it("sets the progress and answers the phase, the new version and the villa's overall progress", async () => {
    const res = await patch(40);

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"2"');
    expect(res.body.data).toEqual({
      elecPhaseId: first().id,
      name: "Ceiling Piping",
      order: 1,
      progress: 40,
      state: "IN_PROGRESS",
      version: 2,
      // 40 is not done: the phase adds nothing to the villa yet.
      villaProgress: 0,
      phaseCount: 6,
    });
    expect(rowOf()).toMatchObject({ progress: 40, version: 2 });
  });

  it.each([
    [0, "NOT_STARTED"],
    [1, "IN_PROGRESS"],
    [99, "IN_PROGRESS"],
    [100, "DONE"],
  ])("progress %i is %s", async (progress, state) => {
    await patch(50);

    const res = await patch(progress);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ progress, state });
  });

  it("100 completes the phase and going below clears the completion", async () => {
    await patch(100);
    const done = rowOf().completedAt;
    await patch(100);
    expect(done).toBeInstanceOf(Date);
    expect(rowOf().completedAt).toBe(done);

    await patch(99);
    expect(rowOf().completedAt).toBeNull();

    await patch(100);
    await patch(0);
    expect(rowOf()).toMatchObject({ progress: 0, completedAt: null });
  });

  it("adds up to 100 once every phase is done", async () => {
    for (const phase of phases) {
      await patch(100, {}, phase);
    }

    const res = await patch(100, {}, first());

    expect(res.body.data.villaProgress).toBe(100);
    const detail = await send("get", `/villas/${villa.id}`);
    expect(detail.body.data).toMatchObject({ progress: 100, phaseCount: 6 });
  });

  it("adds a phase's whole ratio to the villa once its open work is done, and nothing before", async () => {
    expect((await patch(100, {}, first())).body.data.villaProgress).toBe(20);
    // Half done adds nothing.
    expect((await patch(50, {}, second())).body.data.villaProgress).toBe(20);
    expect((await patch(100, {}, second())).body.data.villaProgress).toBe(40);

    const detail = await send("get", `/villas/${villa.id}`);
    expect(detail.body.data).toMatchObject({ progress: 40, phaseCount: 6 });
    const list = await send("get", "/villas");
    expect(list.body.data[0]).toMatchObject({ id: villa.id, progress: 40 });
  });

  it("reads each phase, and the villa, from the villa's open works, not from the phase's own progress", async () => {
    // The first phase has two open works: its progress is their average, (100 + 40) / 2 = 70, so it is not done.
    setPhaseOpenWork(villa.id, first().id, 100);
    workItemTables.items.push({
      ...workItemTables.items[0]!,
      id: "manual-1",
      progress: 40,
    });
    // The second phase's own progress row is at 100, but it has no open work: it is at 0.
    rowOf(second()).progress = 100;

    const detail = await send("get", `/villas/${villa.id}`);

    expect(detail.body.data.progress).toBe(0);
    expect(detail.body.data.phases.slice(0, 2)).toMatchObject([
      { elecPhaseId: first().id, progress: 70, state: "IN_PROGRESS" },
      { elecPhaseId: second().id, progress: 0, state: "NOT_STARTED" },
    ]);

    // Both of the first phase's open works done: the phase adds its 20.
    workItemTables.items.find((item) => item.id === "manual-1")!.progress = 100;
    expect((await send("get", "/villas")).body.data[0]).toMatchObject({ progress: 20 });
  });

  it("leaves another villa and another phase alone", async () => {
    const other = addVilla({ villaNumber: "P-002" });
    seedRows();

    await patch(70);

    expect(rowOf(first(), other).progress).toBe(0);
    expect(rowOf(second()).progress).toBe(0);
  });

  it("audits the change once, in the same unit of work, with before and after", async () => {
    await patch(25);

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actorId: admin.id,
      action: "villa.progress",
      entity: "Villa",
      entityId: villa.id,
      before: { elecPhaseId: first().id, phase: "Ceiling Piping", progress: 0 },
      after: { elecPhaseId: first().id, phase: "Ceiling Piping", progress: 25 },
    });
  });

  it("rolls the change back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await patch(25);

    expect(res.status).toBe(500);
    expect(rowOf()).toMatchObject({ progress: 0, version: 1 });
  });

  describe("setting what is already there", () => {
    it("changes nothing: no new version, no audit entry, the same answer", async () => {
      await patch(30);
      const before = auditRows().length;

      const again = await patch(30);

      expect(again.status).toBe(200);
      expect(again.body.data).toMatchObject({ progress: 30, version: 2 });
      expect(rowOf().version).toBe(2);
      expect(auditRows()).toHaveLength(before);
    });

    it("0 on a phase that is at 0 is not a change either", async () => {
      const res = await patch(0);

      expect(res.status).toBe(200);
      expect(res.body.data.version).toBe(1);
      expect(auditRows()).toHaveLength(0);
    });
  });

  describe("an inactive phase", () => {
    beforeEach(() => {
      second().status = "INACTIVE";
    });

    it("answers 409 ELEC_PHASE_INACTIVE, translated, and changes nothing", async () => {
      const res = await patch(50, { language: "ar" }, second());

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "ELEC_PHASE_INACTIVE",
        message: "هذه المرحلة معطلة، لذلك لا يمكن تغيير نسبة الإنجاز فيها",
      });
      expect(rowOf(second())).toMatchObject({ progress: 0, version: 1 });
      expect(auditRows()).toHaveLength(0);
    });

    it("refuses even the value the phase already has", async () => {
      expect((await patch(0, {}, second())).status).toBe(409);
    });

    it("keeps its progress out of the average and brings it back when the phase is reactivated", async () => {
      second().status = "ACTIVE";
      await patch(100, {}, second());
      await patch(100, {}, first());
      second().status = "INACTIVE";

      const withoutIt = await send("get", `/villas/${villa.id}`);
      second().status = "ACTIVE";
      const withIt = await send("get", `/villas/${villa.id}`);

      // The first phase's 20 alone, then the second's 20 too.
      expect(withoutIt.body.data).toMatchObject({ progress: 20, phaseCount: 5 });
      expect(withIt.body.data).toMatchObject({ progress: 40, phaseCount: 6 });
      expect(rowOf(second()).progress).toBe(100);
    });
  });

  describe("unknown records", () => {
    it("answers 404 VILLA_NOT_FOUND for an unknown villa, translated", async () => {
      const res = await send("patch", `/villas/${MISSING_ID}/phases/${first().id}`, {
        body: { progress: 5 },
        language: "ar",
      });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "VILLA_NOT_FOUND", message: "الفيلا غير موجودة" });
    });

    it("answers 404 ELEC_PHASE_NOT_FOUND for an unknown phase", async () => {
      const res = await send("patch", `/villas/${villa.id}/phases/${MISSING_ID}`, { body: { progress: 5 } });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ELEC_PHASE_NOT_FOUND");
    });

    it("answers 404 for an unknown id even with a stale If-Match", async () => {
      const res = await send("patch", `/villas/${MISSING_ID}/phases/${first().id}`, {
        body: { progress: 5 },
        ifMatch: "9",
      });

      expect(res.status).toBe(404);
    });

    it("answers 404, not 500, when the villa is deleted between the check and the write", async () => {
      const other = addVilla({ villaNumber: "P-002" });
      vi.spyOn(InMemoryVillaProgressRepository.prototype, "lockRow").mockImplementationOnce(async () => {
        villaTables.villas = villaTables.villas.filter((v) => v.id !== other.id);
        throw Object.assign(new Error("Prisma P2003"), {
          code: "P2003",
          meta: {
            driverAdapterError: {
              cause: { constraint: { index: "VillaPhaseProgress_villaId_fkey" } },
            },
          },
        });
      });

      const res = await patch(5, {}, first(), other);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("VILLA_NOT_FOUND");
    });

    it("answers 404 ELEC_PHASE_NOT_FOUND when the phase is deleted between the check and the write", async () => {
      vi.spyOn(InMemoryVillaProgressRepository.prototype, "lockRow").mockRejectedValueOnce(
        Object.assign(new Error("Prisma P2003"), {
          code: "P2003",
          meta: {
            driverAdapterError: {
              cause: { constraint: { index: "VillaPhaseProgress_elecPhaseId_fkey" } },
            },
          },
        }),
      );

      const res = await patch(5);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("ELEC_PHASE_NOT_FOUND");
    });
  });

  describe("validation", () => {
    it.each([-1, 101, 1.5, 0.1, 1e3, "50", "", null, true, [], {}, Number.MAX_SAFE_INTEGER])(
      "refuses progress %j with 400, translated, and changes nothing",
      async (value) => {
        const res = await patch(value, { language: "ar" });

        expect(res.status).toBe(400);
        expect(res.body.details[0]).toMatchObject({
          path: "progress",
          message: "يجب أن تكون نسبة الإنجاز رقمًا صحيحًا من 0 إلى 100",
        });
        expect(rowOf().version).toBe(1);
      },
    );

    it("refuses a missing progress and any other field", async () => {
      const missing = await send("patch", pathOf(), { body: {} });
      const extra = await send("patch", pathOf(), { body: { progress: 5, version: 3 } });

      expect(missing.status).toBe(400);
      expect(missing.body.details[0].path).toBe("progress");
      expect(extra.status).toBe(400);
      expect(rowOf().version).toBe(1);
    });

    it.each([0, 100])("accepts the bounds (%i)", async (value) => {
      await patch(50);

      expect((await patch(value)).status).toBe(200);
    });

    it("refuses ids that are not uuids with 400", async () => {
      const badVilla = await send("patch", `/villas/nope/phases/${first().id}`, { body: { progress: 5 } });
      const badPhase = await send("patch", `/villas/${villa.id}/phases/nope`, { body: { progress: 5 } });

      expect(badVilla.status).toBe(400);
      expect(badPhase.status).toBe(400);
    });

    it("does not read a 100% sent as text", async () => {
      expect((await patch("100")).status).toBe(400);
    });
  });

  describe("versions (If-Match is the version of the progress row)", () => {
    it("takes the version from the villa's detail and refuses a stale one with 409", async () => {
      const detail = await send("get", `/villas/${villa.id}`);
      const version = detail.body.data.phases[0].version;

      const ok = await patch(10, { ifMatch: String(version) });
      const stale = await patch(20, { ifMatch: String(version) });

      expect(ok.status).toBe(200);
      expect(ok.body.data.version).toBe(version + 1);
      conflict(stale, version + 1);
      expect(rowOf().progress).toBe(10);
      expect(auditRows()).toHaveLength(1);
    });

    it("works without an If-Match, as the other updates do", async () => {
      expect((await patch(10)).status).toBe(200);
    });

    it.each(["1", '"1"', 'W/"1"'])("accepts If-Match %s for version 1", async (header) => {
      expect((await patch(10, { ifMatch: header })).status).toBe(200);
    });

    it.each(["abc", "0", "-1", "1.5", "3,4"])("refuses a malformed If-Match %j with 400", async (header) => {
      const res = await patch(10, { ifMatch: header });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_IF_MATCH");
      expect(rowOf().version).toBe(1);
    });

    it("a stale If-Match is refused even for the value the phase already has", async () => {
      await patch(10);

      conflict(await patch(10, { ifMatch: "1" }), 2);
    });

    it("is a 409 in Arabic too", async () => {
      await patch(10);

      const res = await patch(20, { ifMatch: "1", language: "ar" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("VERSION_CONFLICT");
    });

    it("two updates at the same moment with the same version: one wins, the other is a 409", async () => {
      const [a, b] = await Promise.all([patch(10, { ifMatch: "1" }), patch(20, { ifMatch: "1" })]);

      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(rowOf().version).toBe(2);
      expect(auditRows()).toHaveLength(1);
    });

    it("answers 409, never a silent overwrite, when the row moves between the lock and the write", async () => {
      vi.spyOn(InMemoryVillaProgressRepository.prototype, "update").mockResolvedValueOnce(null);

      conflict(await patch(10), 1);

      expect(rowOf()).toMatchObject({ progress: 0, version: 1 });
      expect(auditRows()).toHaveLength(0);
    });
  });

  describe("a missing progress row", () => {
    it("is created at 0 and then updated, so the update still works", async () => {
      progressTables.rows = progressTables.rows.filter(
        (r) => !(r.villaId === villa.id && r.elecPhaseId === first().id),
      );

      const res = await patch(10);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ progress: 10, version: 2 });
      expect(rowOf().progress).toBe(10);
    });

    it("is read as 0, version 1, in the villa's detail", async () => {
      progressTables.rows = [];

      const detail = await send("get", `/villas/${villa.id}`);

      expect(detail.body.data.progress).toBe(0);
      expect(detail.body.data.phases[0]).toMatchObject({ progress: 0, version: 1, state: "NOT_STARTED" });
    });
  });

  describe("with an Idempotency-Key", () => {
    it("runs once: the same key and body again replays the first answer", async () => {
      const firstTime = await patch(40, { key: KEY });
      const again = await patch(40, { key: KEY });

      expect(firstTime.status).toBe(200);
      expect(firstTime.headers["idempotent-replayed"]).toBeUndefined();
      expect(again.status).toBe(200);
      expect(again.headers["idempotent-replayed"]).toBe("true");
      expect(again.body).toEqual(firstTime.body);
      expect(rowOf().version).toBe(2);
      expect(auditRows()).toHaveLength(1);
    });

    it("answers 422 IDEMPOTENCY_KEY_REUSED when the key comes back with another body", async () => {
      await patch(40, { key: KEY });

      const reused = await patch(50, { key: KEY });

      expect(reused.status).toBe(422);
      expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
      expect(rowOf().progress).toBe(40);
    });

    it("does not keep a 5xx: after the audit write fails the same key runs again", async () => {
      store.failAuditWith = new Error("audit down");
      vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const failed = await patch(40, { key: KEY });
      store.failAuditWith = null;
      const retried = await patch(40, { key: KEY });

      expect(failed.status).toBe(500);
      expect(retried.status).toBe(200);
      expect(rowOf().progress).toBe(40);
    });

    it("refuses a malformed key with 400 INVALID_IDEMPOTENCY_KEY", async () => {
      const res = await patch(40, { key: "short" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("INVALID_IDEMPOTENCY_KEY");
      expect(rowOf().progress).toBe(0);
    });
  });

  describe("the hook for the open works (slice 9)", () => {
    it("runs inside the update, with the change, and a failure undoes the whole update", async () => {
      progressChangeHooks.push(async (_tx, change) => {
        expect(change).toMatchObject({
          villaId: villa.id,
          phase: { id: first().id, name: "Ceiling Piping" },
          before: { progress: 0, completedAt: null },
          after: { progress: 100 },
        });
        throw new Error("hook failed");
      });
      vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const res = await patch(100);

      expect(res.status).toBe(500);
      expect(rowOf()).toMatchObject({ progress: 0, completedAt: null, version: 1 });
      expect(auditRows()).toHaveLength(0);
    });
  });
});

describe("what the villas show", () => {
  it("GET /villas/:id lists the active phases in display order, with order, state and version", async () => {
    await patch(100);
    await patch(50, {}, second());
    phases[5]!.status = "INACTIVE";

    const res = await send("get", `/villas/${villa.id}`);

    // The first phase is done (20); the second, at 50, adds nothing yet.
    expect(res.body.data).toMatchObject({ phaseCount: 5, progress: 20 });
    expect(res.body.data.phases).toEqual([
      { elecPhaseId: first().id, name: "Ceiling Piping", order: 1, progress: 100, state: "DONE", version: 2 },
      {
        elecPhaseId: second().id,
        name: "MSB Box Fixing",
        order: 2,
        progress: 50,
        state: "IN_PROGRESS",
        version: 2,
      },
      {
        elecPhaseId: phases[2]!.id,
        name: "Cut/out Box Fixing",
        order: 3,
        progress: 0,
        state: "NOT_STARTED",
        version: 1,
      },
      {
        elecPhaseId: phases[3]!.id,
        name: "D.B Box Fixing",
        order: 4,
        progress: 0,
        state: "NOT_STARTED",
        version: 1,
      },
      {
        elecPhaseId: phases[4]!.id,
        name: "Wall Piping",
        order: 5,
        progress: 0,
        state: "NOT_STARTED",
        version: 1,
      },
    ]);
    for (const phase of res.body.data.phases) {
      expect(phase).not.toHaveProperty("completedAt");
    }
  });

  it("follows the display order when the phases are reordered", async () => {
    first().sortOrder = 9;

    const res = await send("get", `/villas/${villa.id}`);

    expect(res.body.data.phases.map((p: { name: string }) => p.name).at(-1)).toBe("Ceiling Piping");
    expect(res.body.data.phases.at(-1).order).toBe(9);
  });

  it("with no active phase the progress is 0, phaseCount 0 and phases empty (never NaN)", async () => {
    for (const phase of phases) phase.status = "INACTIVE";

    const res = await send("get", `/villas/${villa.id}`);

    expect(res.body.data).toMatchObject({ progress: 0, phaseCount: 0, phases: [] });
  });

  it("GET /villas shows each villa's progress: the ratios of its done phases", async () => {
    const other = addVilla({ villaNumber: "P-002" });
    seedRows();
    await patch(100);
    await patch(1, {}, first(), other);

    const res = await send("get", "/villas?sort=villaNumber");

    expect(
      res.body.data.map((v: { villaNumber: string; progress: number }) => [v.villaNumber, v.progress]),
    ).toEqual([
      ["P-001", 20],
      ["P-002", 0],
    ]);
  });

  describe("sort=progress", () => {
    let a: StoredVilla;
    let b: StoredVilla;
    let c: StoredVilla;
    beforeEach(async () => {
      a = addVilla({ villaNumber: "P-002" });
      b = addVilla({ villaNumber: "P-003" });
      c = addVilla({ villaNumber: "P-004" });
      seedRows();
      // a at 40 (two phases done), b and c at 20 (one), the first villa at 0.
      await patch(100, {}, first(), a);
      await patch(100, {}, second(), a);
      await patch(100, {}, first(), b);
      await patch(100, {}, first(), c);
    });
    const numbers = (res: request.Response): string[] =>
      res.body.data.map((v: { villaNumber: string }) => v.villaNumber);

    it("orders by the overall progress, lowest first, ties by id", async () => {
      const res = await send("get", "/villas?sort=progress");

      const tied = [b, c].sort((x, y) => (x.id < y.id ? -1 : 1)).map((v) => v.villaNumber);
      expect(numbers(res)).toEqual(["P-001", ...tied, "P-002"]);
    });

    it("progress:desc puts the furthest along first", async () => {
      const res = await send("get", "/villas?sort=progress:desc");

      expect(numbers(res)[0]).toBe("P-002");
      expect(numbers(res).at(-1)).toBe("P-001");
    });

    it("pages without repeating or skipping a villa", async () => {
      const one = await send("get", "/villas?sort=progress&limit=2&page=1");
      const two = await send("get", "/villas?sort=progress&limit=2&page=2");

      expect([...numbers(one), ...numbers(two)]).toHaveLength(4);
      expect(new Set([...numbers(one), ...numbers(two)]).size).toBe(4);
    });

    it("counts only the active phases", async () => {
      second().status = "INACTIVE";
      // a keeps only its first phase (20), b gets a third one done (20 + 15).
      await patch(0, {}, first(), a);
      phases[2]!.status = "ACTIVE";
      await patch(100, {}, phases[2]!, b);

      const res = await send("get", "/villas?sort=progress:desc");

      expect(numbers(res)[0]).toBe("P-003");
    });
  });
});

describe("keeping a row per villa and phase", () => {
  async function createVilla(number: string) {
    return send("post", "/villas", {
      body: {
        villaNumber: number,
        areaId: areaNamed("Zayed"),
        block: "B9",
        plot: number,
        civilEngineerId: engineerTables.engineers[0]!.id,
      },
    });
  }

  it("a new villa gets a row at 0 for every phase, inactive ones too, in the same transaction", async () => {
    second().status = "INACTIVE";

    const res = await createVilla("NEW-1");

    expect(res.status).toBe(201);
    expect(res.body.data.progress).toBe(0);
    const rows = progressTables.rows.filter((r) => r.villaId === res.body.data.id);
    expect(rows.map((r) => r.elecPhaseId).sort()).toEqual(phases.map((p) => p.id).sort());
    expect(rows.every((r) => r.progress === 0 && r.version === 1 && r.completedAt === null)).toBe(true);
  });

  it("a villa that is not created (duplicate number) leaves no rows behind", async () => {
    const before = progressTables.rows.length;

    const res = await createVilla("P-001");

    expect(res.status).toBe(409);
    expect(progressTables.rows).toHaveLength(before);
  });

  it("a new phase gets a row at 0 for every villa", async () => {
    addVilla({ villaNumber: "P-002" });
    seedRows();

    const res = await send("post", "/elec-phases", { body: { name: "Final Fix" } });

    expect(res.status).toBe(201);
    const rows = progressTables.rows.filter((r) => r.elecPhaseId === res.body.data.id);
    expect(rows.map((r) => r.villaId).sort()).toEqual(villaTables.villas.map((v) => v.id).sort());
  });

  it("a new inactive phase gets its rows too, and is left out of the average", async () => {
    const res = await send("post", "/elec-phases", { body: { name: "Final Fix", status: "INACTIVE" } });

    expect(progressTables.rows.filter((r) => r.elecPhaseId === res.body.data.id)).toHaveLength(1);
    expect((await send("get", `/villas/${villa.id}`)).body.data.phaseCount).toBe(6);
  });

  it("a phase that fails to be created (duplicate name) leaves no rows behind", async () => {
    const before = progressTables.rows.length;

    const res = await send("post", "/elec-phases", { body: { name: "sleeves" } });

    expect(res.status).toBe(409);
    expect(progressTables.rows).toHaveLength(before);
  });

  it("deleting a villa deletes its rows", async () => {
    const other = addVilla({ villaNumber: "P-002" });
    seedRows();

    const res = await send("delete", `/villas/${villa.id}`);

    expect(res.status).toBe(204);
    expect(progressTables.rows.some((r) => r.villaId === villa.id)).toBe(false);
    expect(progressTables.rows.filter((r) => r.villaId === other.id)).toHaveLength(6);
  });
});

describe("deleting a phase", () => {
  it("a phase every villa is still at 0 in can be deleted, and its rows go with it", async () => {
    addVilla({ villaNumber: "P-002" });
    seedRows();

    const res = await send("delete", `/elec-phases/${first().id}`);

    expect(res.status).toBe(204);
    expect(phaseTables.phases.some((p) => p.id === first().id)).toBe(false);
    expect(progressTables.rows.some((r) => r.elecPhaseId === first().id)).toBe(false);
  });

  it("a phase with any progress above 0 is in use: 409 ELEC_PHASE_IN_USE, nothing deleted", async () => {
    const other = addVilla({ villaNumber: "P-002" });
    seedRows();
    await patch(1, {}, first(), other);

    const res = await send("delete", `/elec-phases/${first().id}`, { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ELEC_PHASE_IN_USE");
    expect(phaseTables.phases.some((p) => p.id === first().id)).toBe(true);
    expect(progressTables.rows.filter((r) => r.elecPhaseId === first().id)).toHaveLength(2);
  });

  it("is in use even when it is inactive, and is deletable again once the progress is back at 0", async () => {
    // About the progress rows alone: with the open works sync on, the phase's automatic open work would keep it in use.
    progressChangeHooks.length = 0;
    // A refused delete rolls back and puts clones in the table, so the phase is looked up each time.
    const live = (): StoredPhase => phaseTables.phases.find((p) => p.id === first().id)!;
    await patch(30);
    live().status = "INACTIVE";
    const refused = await send("delete", `/elec-phases/${first().id}`);
    live().status = "ACTIVE";
    await patch(0);
    live().status = "INACTIVE";

    const deleted = await send("delete", `/elec-phases/${first().id}`);

    expect(refused.status).toBe(409);
    expect(deleted.status).toBe(204);
    expect(progressTables.rows.some((r) => r.elecPhaseId === first().id)).toBe(false);
  });

  it("answers 409 ELEC_PHASE_IN_USE when a villa moves the phase above 0 after the check (the foreign key)", async () => {
    const other = addVilla({ villaNumber: "P-002" });
    seedRows();
    const deleteZero = vi
      .spyOn(
        (await import("../elec-phases/in-memory-elec-phases.repository.js")).InMemoryElecPhasesRepository
          .prototype,
        "deleteZeroProgress",
      )
      .mockImplementationOnce(async () => {
        rowOf(first(), other).progress = 7;
      });

    const res = await send("delete", `/elec-phases/${first().id}`);

    expect(deleteZero).toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ELEC_PHASE_IN_USE");
    expect(phaseTables.phases.some((p) => p.id === first().id)).toBe(true);
  });

  it("a rejected delete keeps the zero rows too (all or nothing)", async () => {
    await patch(30);

    await send("delete", `/elec-phases/${first().id}`);

    expect(progressTables.rows.filter((r) => r.elecPhaseId === first().id)).toHaveLength(1);
  });
});

describe("unrelated phases", () => {
  it("adding a phase after a villa has progress does not change the villa's other phases", async () => {
    await patch(100);

    await send("post", "/elec-phases", { body: { name: "Extra" } });

    expect(rowOf().progress).toBe(100);
    // The new phase's ratio is 0: the villa keeps the first phase's 20.
    expect((await send("get", `/villas/${villa.id}`)).body.data).toMatchObject({
      phaseCount: 7,
      progress: 20,
    });
  });
});

// A phase's progress has its own version, so changing it leaves the villa's version where it was. The detail still shows the
// new phases and progress, so its ETag cannot be a cache validator: a conditional GET with the old one must get the new body.
describe("the villa detail after a phase changes", () => {
  const getWith = async (headers: Record<string, string>) => {
    const req = request(app)
      .get(`/api/v1/villas/${villa.id}`)
      .set(await as(admin));
    for (const [name, value] of Object.entries(headers)) req.set(name, value);
    return req;
  };

  it("is answered 200 with the new phases and progress to a request with the old ETag, never 304", async () => {
    const before = await send("get", `/villas/${villa.id}`);
    const oldTag = before.headers["etag"] as string;
    expect(before.body.data).toMatchObject({ version: 1, progress: 0 });

    const changed = await patch(100);
    expect(changed.status).toBe(200);
    expect(changed.body.data).toMatchObject({ progress: 100, villaProgress: 20 });
    // The answer to the change is not stored either.
    expect(changed.headers["cache-control"]).toBe("private, no-store");

    const after = await getWith({ "If-None-Match": oldTag });

    expect(after.status).toBe(200);
    expect(after.body.data.progress).toBe(20);
    expect(
      after.body.data.phases.find((p: { elecPhaseId: string }) => p.elecPhaseId === first().id),
    ).toMatchObject({ progress: 100, version: 2 });
  });

  it("still carries the villa's ETag and version, which the phase change did not move, and is not cacheable", async () => {
    const before = await send("get", `/villas/${villa.id}`);
    await patch(100);

    const after = await getWith({ "If-None-Match": before.headers["etag"] as string });

    expect(after.headers["etag"]).toBe(before.headers["etag"]);
    expect(after.headers["etag"]).toBe(`"${after.body.data.version}"`);
    expect(after.body.data.version).toBe(1);
    expect(after.headers["cache-control"]).toBe("private, no-store");
  });

  it.each([
    ["the current ETag, even unchanged", '"1"'],
    ["a weak form of it", 'W/"1"'],
    ["a list of tags", '"9", "1"'],
    ["any tag", "*"],
  ])("is answered 200 to If-None-Match with %s", async (_name, tag) => {
    const res = await getWith({ "If-None-Match": tag });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(villa.id);
  });

  it("is answered 200 to If-Modified-Since as well", async () => {
    const res = await getWith({ "If-Modified-Since": new Date(Date.now() + 86_400_000).toUTCString() });

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(villa.id);
  });
});
