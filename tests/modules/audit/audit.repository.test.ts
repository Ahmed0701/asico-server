import { describe, expect, it, vi } from "vitest";
import { AuditRepository, type Db } from "../../../src/modules/audit/repository/audit.repository.js";

// The filters the repository hands to the database, seen on a stand-in for the client: the action filter takes every code an
// action was ever written under, and the dropdown options fold those codes into one per action.
function stub(groups: { actions?: string[]; entities?: string[] } = {}) {
  const findMany = vi.fn<(args: unknown) => Promise<unknown[]>>(async () => []);
  const count = vi.fn<(args: unknown) => Promise<number>>(async () => 0);
  const groupBy = vi.fn(async ({ by }: { by: string[] }) =>
    (by[0] === "action" ? (groups.actions ?? []) : (groups.entities ?? [])).map((value) => ({
      [by[0] as string]: value,
    })),
  );
  const db = {
    auditLog: { findMany, count, groupBy },
    user: { findMany: vi.fn(async () => []) },
  } as unknown as Db;
  return { db, findMany, count, groupBy };
}

const SORT = { field: "createdAt", direction: "desc" } as const;
const whereOf = async (filters: Record<string, unknown>) => {
  const { db, findMany, count } = stub();
  await new AuditRepository().list({ filters, sort: SORT, skip: 0, take: 20 }, db);
  const [{ where }] = findMany.mock.calls[0] as [{ where: unknown }];
  // The rows and the total are counted on the same condition.
  expect(count.mock.calls[0]?.[0]).toEqual({ where });
  return where as Record<string, unknown>;
};

describe("the action filter", () => {
  it("takes the code an action is written under today and the legacy codes it was written under before", async () => {
    const where = await whereOf({ action: "villa.create" });

    expect(where).toEqual({ action: { in: ["villa.create", "project.create"] } });
  });

  it("takes the same codes when asked for by a legacy code", async () => {
    const where = await whereOf({ action: "project.create" });

    expect(where).toEqual({ action: { in: ["villa.create", "project.create"] } });
  });

  it("takes an action with no legacy code as that code alone", async () => {
    expect(await whereOf({ action: "area.create" })).toEqual({ action: { in: ["area.create"] } });
  });

  it("takes a code it does not know as that code alone (an old entry the labels never heard of)", async () => {
    expect(await whereOf({ action: "widget.explode" })).toEqual({ action: { in: ["widget.explode"] } });
  });

  it("is left out when no action is asked for", async () => {
    expect(await whereOf({})).toEqual({});
    expect(await whereOf({ action: "" })).toEqual({});
  });

  it("holds beside a search: both narrow the result", async () => {
    const where = await whereOf({ action: "villa.create", search: "creat" });

    expect(where).toEqual({
      action: { in: ["villa.create", "project.create"] },
      OR: [
        { action: { contains: "creat", mode: "insensitive" } },
        { entity: { contains: "creat", mode: "insensitive" } },
      ],
    });
  });

  it("holds beside the other filters", async () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const where = await whereOf({
      action: "area.create",
      actorId: "u1",
      entityId: "e1",
      from,
      entity: "Area",
    });

    expect(where).toMatchObject({
      action: { in: ["area.create"] },
      actorId: "u1",
      entityId: "e1",
      createdAt: { gte: from },
    });
  });
});

describe("the options of the filters", () => {
  it("fold the legacy action codes into the action they stand for, once each, sorted", async () => {
    const { db } = stub({
      actions: [
        "villa.update",
        "project.create",
        "area.create",
        "project.update",
        "villa.create",
        "project.create",
      ],
    });

    const options = await new AuditRepository().filterOptions(db);

    expect(options.actions).toEqual(["area.create", "villa.create", "villa.update"]);
  });

  it("keep a code the application does not know, as it is", async () => {
    const { db } = stub({ actions: ["widget.explode", "area.create"] });

    expect((await new AuditRepository().filterOptions(db)).actions).toEqual([
      "area.create",
      "widget.explode",
    ]);
  });

  it("sort the entities, with the legacy ones folded", async () => {
    const { db } = stub({ entities: ["Villa", "Project", "Area", "ProjectFile"] });

    const { entities } = await new AuditRepository().filterOptions(db);

    expect(entities).toEqual([...entities].sort());
    expect(entities).not.toContain("Project");
    expect(entities).not.toContain("ProjectFile");
  });
});
