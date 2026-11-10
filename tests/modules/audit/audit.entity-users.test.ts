import { describe, expect, it, vi } from "vitest";
import { detailFromSnapshots } from "../../../src/modules/audit/dto/entities.js";
import {
  AuditRepository,
  type Db,
  type EntityNameRow,
} from "../../../src/modules/audit/repository/audit.repository.js";

// A user is named by their name and told apart by their email: from the record while it exists, from the entry's own
// snapshot once it is gone (the same approach as every other entity).

function stub(tables: {
  user?: Record<string, { name: string; email: string }>;
  villa?: Record<string, { villaNumber: string }>;
  auditLog?: Record<string, { before?: unknown; after?: unknown }>;
}) {
  const reading = (table: Record<string, object> = {}) =>
    vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.filter((id) => id in table).map((id) => ({ id, ...table[id] })),
    );
  const raw = {
    user: { findMany: reading(tables.user) },
    villa: { findMany: reading(tables.villa) },
    auditLog: { findMany: reading(tables.auditLog) },
  };
  return { db: raw as unknown as Db, raw };
}

const entry = (id: string, entity: string, entityId: string | null, extra: Partial<EntityNameRow> = {}) => ({
  id,
  entity,
  entityId,
  ...extra,
});

const repository = new AuditRepository();
const SARA = { name: "Sara Ali", email: "sara@example.test" };

describe("the name and email of a user", () => {
  it("is the user's name and email while the user exists", async () => {
    const { db } = stub({ user: { u1: SARA } });

    const refs = await repository.entityRefs([entry("1", "User", "u1")], db);

    expect(refs.get("1")).toEqual({ name: "Sara Ali", detail: "sara@example.test" });
  });

  it("reads the user's id, name and email and nothing else", async () => {
    const { db, raw } = stub({ user: { u1: SARA } });

    await repository.entityRefs([entry("1", "User", "u1")], db);

    expect(raw.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["u1"] } },
      select: { id: true, name: true, email: true },
    });
  });

  it("runs one query for all the users of a page", async () => {
    const { db, raw } = stub({ user: { u1: SARA, u2: { name: "Omar", email: "omar@example.test" } } });

    const refs = await repository.entityRefs(
      [entry("1", "User", "u1"), entry("2", "User", "u2"), entry("3", "User", "u1")],
      db,
    );

    expect(raw.user.findMany).toHaveBeenCalledTimes(1);
    expect([...refs.values()].map((ref) => ref.detail)).toEqual([
      "sara@example.test",
      "omar@example.test",
      "sara@example.test",
    ]);
  });

  it("is the name and email of the entry's own snapshot once the user is gone", async () => {
    const { db } = stub({ auditLog: { a1: { before: null, after: { ...SARA, role: "EMPLOYEE" } } } });

    const refs = await repository.entityRefs([entry("a1", "User", "gone")], db);

    expect(refs.get("a1")).toEqual({ name: "Sara Ali", detail: "sara@example.test" });
  });

  it("takes the newest snapshot that has each of them (after, then before)", async () => {
    const { db } = stub({});

    const refs = await repository.entityRefs(
      [
        entry("1", "User", "gone", {
          before: { name: "Old Name", email: "old@example.test" },
          after: { name: "New Name", email: "new@example.test" },
        }),
        entry("2", "User", "gone", { before: { name: "Old Name", email: "old@example.test" }, after: null }),
        entry("3", "User", "gone", {
          before: { email: "old@example.test" },
          after: { name: "Only Name" },
        }),
      ],
      db,
    );

    expect(refs.get("1")).toEqual({ name: "New Name", detail: "new@example.test" });
    expect(refs.get("2")).toEqual({ name: "Old Name", detail: "old@example.test" });
    expect(refs.get("3")).toEqual({ name: "Only Name", detail: "old@example.test" });
  });

  it("has a name and no email when the snapshot has only a name (an older entry)", async () => {
    const { db } = stub({ auditLog: { a1: { before: { name: "Administrator" }, after: null } } });

    const refs = await repository.entityRefs([entry("a1", "User", "gone")], db);

    expect(refs.get("a1")).toEqual({ name: "Administrator", detail: null });
  });

  it("is left out when the user is gone and the entry holds no snapshot (a sign-in leaves none)", async () => {
    const { db } = stub({});

    const refs = await repository.entityRefs([entry("a1", "User", "gone")], db);

    expect(refs.has("a1")).toBe(false);
  });

  it("does not take an email for a name: a snapshot with an email alone leaves the entry unnamed", async () => {
    const { db } = stub({});

    const refs = await repository.entityRefs(
      [entry("a1", "User", "gone", { before: null, after: { email: "x@example.test" } })],
      db,
    );

    expect(refs.has("a1")).toBe(false);
  });

  it("ignores a snapshot field that is not text, or only blanks", async () => {
    const { db } = stub({});

    const refs = await repository.entityRefs(
      [entry("a1", "User", "gone", { before: null, after: { name: "Sara", email: "   " } })],
      db,
    );

    expect(refs.get("a1")).toEqual({ name: "Sara", detail: null });
    expect(detailFromSnapshots("User", { email: 42 }, "not an object", null)).toBeNull();
  });

  it("gives every other entity no detail, from the record or from a snapshot", async () => {
    const { db } = stub({
      villa: { p1: { villaNumber: "P-001" } },
      auditLog: {
        a2: { before: { villaNumber: "P-GONE", email: "not-for-a-villa@example.test" }, after: null },
      },
    });

    const refs = await repository.entityRefs([entry("a1", "Villa", "p1"), entry("a2", "Villa", "gone")], db);

    expect(refs.get("a1")).toEqual({ name: "P-001", detail: null });
    expect(refs.get("a2")).toEqual({ name: "P-GONE", detail: null });
  });

  it("entityNames still answers with the names alone", async () => {
    const { db } = stub({ user: { u1: SARA } });

    const names = await repository.entityNames([entry("1", "User", "u1")], db);

    expect(Object.fromEntries(names)).toEqual({ "1": "Sara Ali" });
  });
});

describe("detailFromSnapshots", () => {
  it("is the email for a user and null for an entity that has no detail", () => {
    expect(detailFromSnapshots("User", { email: "a@b.test" })).toBe("a@b.test");
    expect(detailFromSnapshots("Contractor", { email: "a@b.test" })).toBeNull();
    expect(detailFromSnapshots("Widget", { email: "a@b.test" })).toBeNull();
  });

  it("takes the first snapshot that has an email", () => {
    expect(detailFromSnapshots("User", null, { name: "x" }, { email: "late@b.test" })).toBe("late@b.test");
  });
});
