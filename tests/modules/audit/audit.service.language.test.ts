import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../../../src/core/middleware/requestContext.js";
import type {
  AuditLogDetailRow,
  AuditLogListRow,
  AuditRepository,
} from "../../../src/modules/audit/repository/audit.repository.js";
import { AuditService } from "../../../src/modules/audit/service/audit.service.js";
import { KNOWN_ACTIONS } from "../../../src/modules/audit/dto/actions.js";
import { ENTITY_LABEL_KEYS } from "../../../src/modules/audit/dto/entities.js";
import type { ListAuditLogsQuery } from "../../../src/modules/audit/validators/audit.validators.js";

const ctx: RequestContext = { locale: "en" };
const ctxAr: RequestContext = { locale: "ar" };
const query: ListAuditLogsQuery = { page: 1, limit: 20 };

const row = (id: string, entity: string, entityId: string | null = null): AuditLogListRow => ({
  id,
  action: "x",
  entity,
  entityId,
  ip: null,
  userAgent: null,
  requestId: null,
  createdAt: new Date("2026-03-04T05:06:07.890Z"),
  actor: null,
});

let repo: {
  list: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  filterOptions: ReturnType<typeof vi.fn>;
  entityRefs: ReturnType<typeof vi.fn>;
};
let service: AuditService;

beforeEach(() => {
  repo = { list: vi.fn(), findById: vi.fn(), filterOptions: vi.fn(), entityRefs: vi.fn() };
  service = new AuditService(repo as unknown as AuditRepository);
});

describe("list with a request context", () => {
  const rows = [row("1", "Villa", "p1"), row("2", "Contractor", "c1"), row("3", "Widget", "w1")];

  beforeEach(() => {
    repo.list.mockResolvedValue({ rows, total: 3 });
    repo.entityRefs.mockResolvedValue(
      new Map([
        ["1", { name: "P-001", detail: null }],
        ["2", { name: "Nile Builders", detail: null }],
      ]),
    );
  });

  it("labels each entity in the language, keeps its code, and adds the names that were found", async () => {
    const { items } = await service.list(query, ctxAr);

    expect(items.map((i) => [i.entity, i.entityCode, i.entityName])).toEqual([
      ["فيلا", "Villa", "P-001"],
      ["مقاول", "Contractor", "Nile Builders"],
      ["Widget", "Widget", null],
    ]);
  });

  it("is English in English", async () => {
    const { items } = await service.list(query, ctx);

    expect(items.map((i) => i.entity)).toEqual(["Villa", "Contractor", "Widget"]);
  });

  it("looks the names up once for the whole page, with the rows of the page", async () => {
    await service.list(query, ctxAr);

    expect(repo.entityRefs).toHaveBeenCalledTimes(1);
    expect(repo.entityRefs).toHaveBeenCalledWith(rows);
  });

  it("an entry the lookup has no name for gets null, never undefined", async () => {
    const { items } = await service.list(query, ctx);

    expect(items[2]).toHaveProperty("entityName", null);
    expect(items[2]).toHaveProperty("entityDetail", null);
  });

  it("carries the detail of a user (their email) beside their name, and null for an entity without one", async () => {
    repo.list.mockResolvedValue({ rows: [row("1", "User", "u1"), row("2", "Villa", "p1")], total: 2 });
    repo.entityRefs.mockResolvedValue(
      new Map([
        ["1", { name: "Sara Ali", detail: "sara@example.test" }],
        ["2", { name: "P-001", detail: null }],
      ]),
    );

    const { items } = await service.list(query, ctx);

    expect(items.map((i) => [i.entityName, i.entityDetail])).toEqual([
      ["Sara Ali", "sara@example.test"],
      ["P-001", null],
    ]);
  });

  it("does not change the paging or the filters it passes on", async () => {
    await service.list({ ...query, entity: "Villa", page: 2, limit: 5 }, ctxAr);

    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ entity: "Villa" }), skip: 5, take: 5 }),
    );
  });
});

describe("list without a request context (the audit export)", () => {
  beforeEach(() => {
    repo.list.mockResolvedValue({ rows: [row("1", "CivilEngineer", "e1")], total: 1 });
  });

  it("is in English, by code, and looks no names up", async () => {
    const { items } = await service.list(query);

    expect(items[0]).toMatchObject({
      entity: "Civil engineer",
      entityCode: "CivilEngineer",
      entityName: null,
      entityDetail: null,
    });
    expect(repo.entityRefs).not.toHaveBeenCalled();
  });
});

describe("get", () => {
  const detail: AuditLogDetailRow = {
    ...row("1", "Villa", "p1"),
    before: { status: "OPEN" },
    after: { status: "CLOSED" },
  };

  it("is labelled in the language and carries the name, from the same lookup, given the row it already has", async () => {
    repo.findById.mockResolvedValue(detail);
    repo.entityRefs.mockResolvedValue(new Map([["1", { name: "P-001", detail: null }]]));

    const dto = await service.get("1", ctxAr);

    expect(dto).toMatchObject({
      entity: "فيلا",
      entityCode: "Villa",
      entityName: "P-001",
      after: { status: "CLOSED" },
    });
    expect(repo.entityRefs).toHaveBeenCalledWith([detail]);
  });

  it("has a null name when none is found", async () => {
    repo.findById.mockResolvedValue(detail);
    repo.entityRefs.mockResolvedValue(new Map());

    const dto = await service.get("1", ctx);

    expect(dto).toHaveProperty("entityName", null);
    expect(dto).toHaveProperty("entityDetail", null);
  });

  it("looks nothing up for an entry that does not exist", async () => {
    repo.findById.mockResolvedValue(null);

    await expect(service.get("missing", ctx)).rejects.toMatchObject({ code: "AUDIT_LOG_NOT_FOUND" });
    expect(repo.entityRefs).not.toHaveBeenCalled();
  });
});

describe("filters", () => {
  const options = {
    actions: ["a"],
    entities: ["CivilEngineer", "User", "Widget"],
    actors: [{ id: "1", name: "N" }],
  };

  beforeEach(() => repo.filterOptions.mockResolvedValue(options));

  it("keeps the raw array exactly as the repository found it and adds a label for each code", async () => {
    const en = await service.filters(ctx);
    const ar = await service.filters(ctxAr);

    // What the log holds, joined by everything the application knows (see the filter options tests).
    expect(en.entities).toEqual(
      [...new Set([...Object.keys(ENTITY_LABEL_KEYS), ...options.entities])].sort(),
    );
    expect(ar.entities).toEqual(en.entities);
    expect(en.actions).toEqual([...new Set([...KNOWN_ACTIONS, ...options.actions])].sort());
    expect(en.actors).toEqual(options.actors);
    expect(en.entityLabels).toMatchObject({
      CivilEngineer: "Civil engineer",
      User: "User",
      Widget: "Widget",
    });
    expect(ar.entityLabels).toMatchObject({ CivilEngineer: "مهندس مدني", User: "مستخدم", Widget: "Widget" });
  });

  it("labels every known entity even when the log holds none", async () => {
    repo.filterOptions.mockResolvedValue({ ...options, entities: [] });

    expect(Object.keys((await service.filters(ctx)).entityLabels).sort()).toEqual(
      Object.keys(ENTITY_LABEL_KEYS).sort(),
    );
  });
});
