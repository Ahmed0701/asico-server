import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addContractor, contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import {
  addStartingPhases,
  phaseTables,
  type StoredPhase,
} from "../elec-phases/in-memory-elec-phases.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import {
  InMemoryVillaProgressRepository,
  progressTables,
} from "../villa-progress/in-memory-villa-progress.repository.js";
import {
  InMemoryVillasRepository,
  addVilla,
  villaTables,
  type StoredVilla,
} from "../villas/in-memory-villas.repository.js";
import {
  InMemoryOpenWorksRepository,
  addWorkItem,
  workItemTables,
} from "./in-memory-open-works.repository.js";

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
    VillaProgressRepository: (await import("../villa-progress/in-memory-villa-progress.repository.js"))
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
vi.mock("../../../src/modules/open-works/repository/open-works.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/open-works/repository/open-works.repository.js")
  >()),
  OpenWorksRepository: (await import("./in-memory-open-works.repository.js")).InMemoryOpenWorksRepository,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { progressChangeHooks } from "../../../src/modules/villa-progress/index.js";
import { contractorChangeHooks } from "../../../src/modules/villas/service/villa-hooks.js";

const app = createApp();

let admin: User;
let villa: StoredVilla;
let phases: StoredPhase[];
let nile: ReturnType<typeof addContractor>;
let delta: ReturnType<typeof addContractor>;

beforeEach(() => {
  store.reset();
  engineerTables.reset();
  contractorTables.reset();
  villaTables.reset();
  phaseTables.reset();
  idempotencyTable.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  addEngineer({ name: "Mona Hassan" });
  nile = addContractor({ name: "Nile Builders" });
  delta = addContractor({ name: "Delta Works" });
  phases = addStartingPhases();
  villa = addVilla({ villaNumber: "P-001", contractorId: nile.id });
  progressTables.insertMissing(
    villaTables.villas.flatMap((v) => phaseTables.phases.map((p) => ({ villaId: v.id, elecPhaseId: p.id }))),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  progressChangeHooks.length = 0;
  contractorChangeHooks.length = 0;
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});
const send = async (
  verb: "get" | "post" | "patch" | "delete",
  path: string,
  options: { body?: object; ifMatch?: string; language?: string } = {},
) => {
  const agent = request(app);
  const req = agent[verb](`/api/v1${path}`)
    .set(await as(admin))
    .set("Accept-Language", options.language ?? "en");
  if (options.ifMatch !== undefined) req.set("If-Match", options.ifMatch);
  return options.body === undefined ? req : req.send(options.body);
};
const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];

describe("deleting a villa", () => {
  it("is refused with 409 VILLA_HAS_RECORDS, translated, while it has an open work typed in by hand", async () => {
    addWorkItem({ villaId: villa.id });

    const res = await send("delete", `/villas/${villa.id}`, { language: "ar" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: "VILLA_HAS_RECORDS",
      message:
        "هذه الفيلا بها أعمال مفتوحة أُضيفت يدويًا أو أعمال صغيرة يومية أو تقارير موقع أو عمالة يومية أو توريدات مواد. احذفها أولاً",
    });
    expect(villaTables.villas.some((v) => v.id === villa.id)).toBe(true);
    expect(workItemTables.items).toHaveLength(1);
    expect(progressTables.rows.some((r) => r.villaId === villa.id)).toBe(true);
    expect(auditRows()).toHaveLength(0);
  });

  it("is refused for several open works too", async () => {
    addWorkItem({ villaId: villa.id, elecPhaseId: phases[0]!.id });
    addWorkItem({ villaId: villa.id, elecPhaseId: phases[1]!.id });

    expect((await send("delete", `/villas/${villa.id}`)).status).toBe(409);
    expect(workItemTables.items).toHaveLength(2);
  });

  it("goes through once the manual items are deleted", async () => {
    const manual = addWorkItem({ villaId: villa.id });
    expect((await send("delete", `/villas/${villa.id}`)).status).toBe(409);

    expect((await send("delete", `/open-works/${manual.id}`)).status).toBe(204);
    const res = await send("delete", `/villas/${villa.id}`);

    expect(res.status).toBe(204);
    expect(villaTables.villas.some((v) => v.id === villa.id)).toBe(false);
  });

  it("is not stopped by a villa without any open work", async () => {
    expect((await send("delete", `/villas/${villa.id}`)).status).toBe(204);
  });
});

describe("the phase progress and the open works", () => {
  it("makes no open work: every open work is added by hand", async () => {
    await send("patch", `/villas/${villa.id}/phases/${phases[0]!.id}`, { body: { progress: 30 } });

    expect(progressChangeHooks).toHaveLength(0);
    expect(workItemTables.items).toHaveLength(0);
  });
});

// LOCK ORDER (shared/constants/locks.ts): the villa, the elec phase, the villa's progress rows, then the work items.
// Every write that takes several of them takes them in that order, so none can wait for another in a circle. This runs
// the real services over the in-memory repositories and records which kind of lock each repository call takes.
describe("the lock order", () => {
  const RANK = { villa: 1, phase: 2, progress: 3, item: 4 } as const;
  type Kind = keyof typeof RANK;
  let log: Kind[];

  function record(prototype: object, method: string, kind: Kind): void {
    const target = prototype as Record<string, (...args: unknown[]) => unknown>;
    const original = target[method]!;
    vi.spyOn(target, method).mockImplementation(function (this: unknown, ...args: unknown[]) {
      log.push(kind);
      return original.apply(this, args);
    });
  }

  beforeEach(() => {
    log = [];
    record(InMemoryVillaProgressRepository.prototype, "lockVilla", "villa");
    record(InMemoryVillaProgressRepository.prototype, "lockPhase", "phase");
    record(InMemoryVillaProgressRepository.prototype, "lockRow", "progress");
    record(InMemoryVillasRepository.prototype, "lockVersion", "villa");
    record(InMemoryOpenWorksRepository.prototype, "lockVillaShared", "villa");
    record(InMemoryOpenWorksRepository.prototype, "lockVersion", "item");
  });

  const inOrder = (): boolean => log.every((kind, i) => i === 0 || RANK[log[i - 1]!] <= RANK[kind]);
  // Consecutive duplicates collapsed: "villa, phase, progress, item".
  const shape = (): Kind[] => log.filter((kind, i) => i === 0 || kind !== log[i - 1]);

  it("progress update: villa, phase, then the progress row (no open work is touched)", async () => {
    await send("patch", `/villas/${villa.id}/phases/${phases[0]!.id}`, { body: { progress: 30 } });

    expect(shape()).toEqual(["villa", "phase", "progress"]);
    expect(inOrder()).toBe(true);
  });

  it("villa update that changes the contractor takes no item lock (open works keep their contractor)", async () => {
    addWorkItem({ villaId: villa.id, elecPhaseId: phases[0]!.id, progress: 20, status: "IN_PROGRESS" });

    await send("patch", `/villas/${villa.id}`, { body: { contractorId: delta.id } });

    expect(shape()).toEqual(["villa"]);
  });

  it("villa update that does not change the contractor takes no item lock", async () => {
    await send("patch", `/villas/${villa.id}`, { body: { block: "B7" } });

    expect(shape()).toEqual(["villa"]);
  });

  it("manual create takes the villa; update and delete take the villa, then the item", async () => {
    const created = await send("post", "/open-works", {
      body: { villaId: villa.id, elecPhaseId: phases[0]!.id },
    });
    expect(shape()).toEqual(["villa"]);

    log.length = 0;
    await send("patch", `/open-works/${created.body.data.id}`, { body: { priority: "HIGH" } });
    expect(shape()).toEqual(["villa", "item"]);

    log.length = 0;
    await send("delete", `/open-works/${created.body.data.id}`);
    expect(shape()).toEqual(["villa", "item"]);
    expect(inOrder()).toBe(true);
  });

  it("villa delete takes only the villa", async () => {
    await send("delete", `/villas/${villa.id}`);

    expect(shape()).toEqual(["villa"]);
  });
});
