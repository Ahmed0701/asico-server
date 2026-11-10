import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { RequestContext } from "../../../src/core/middleware/requestContext.js";
import { toDetailDto, toListItemDto } from "../../../src/modules/audit/mapper/audit.mapper.js";
import type {
  AuditLogDetailRow,
  AuditLogListRow,
  AuditRepository,
} from "../../../src/modules/audit/repository/audit.repository.js";
import { AuditService } from "../../../src/modules/audit/service/audit.service.js";
import { KNOWN_ACTIONS } from "../../../src/modules/audit/dto/actions.js";
import {
  listAuditLogsQuerySchema,
  type ListAuditLogsQuery,
} from "../../../src/modules/audit/validators/audit.validators.js";

const ctx: RequestContext = { locale: "en" };
const ctxAr: RequestContext = { locale: "ar" };
const AT = new Date("2026-03-04T05:06:07.890Z");

function listRow(overrides: Partial<AuditLogListRow> = {}): AuditLogListRow {
  return {
    id: "log-1",
    action: "user.create",
    entity: "User",
    entityId: "user-9",
    ip: "203.0.113.5",
    userAgent: "vitest",
    requestId: "req-1",
    createdAt: AT,
    actor: { id: "admin-1", name: "Root Admin", email: "root@example.test" },
    ...overrides,
  };
}

function detailRow(overrides: Partial<AuditLogDetailRow> = {}): AuditLogDetailRow {
  return { ...listRow(), before: null, after: { name: "Sara" }, ...overrides };
}

const query = (overrides: Partial<ListAuditLogsQuery> = {}): ListAuditLogsQuery => ({
  page: 1,
  limit: 20,
  ...overrides,
});

let repo: {
  list: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  filterOptions: ReturnType<typeof vi.fn>;
  entityRefs: ReturnType<typeof vi.fn>;
};
let service: AuditService;

beforeEach(() => {
  repo = {
    list: vi.fn(),
    findById: vi.fn(),
    filterOptions: vi.fn(),
    entityRefs: vi.fn().mockResolvedValue(new Map()),
  };
  service = new AuditService(repo as unknown as AuditRepository);
});

describe("list", () => {
  it("defaults to newest first, page 1, 20 per page, with the shared meta", async () => {
    repo.list.mockResolvedValue({ rows: [listRow(), listRow({ id: "log-2" })], total: 45 });

    const result = await service.list(query());

    expect(repo.list).toHaveBeenCalledWith({
      filters: {
        actorId: undefined,
        action: undefined,
        entity: undefined,
        entityId: undefined,
        from: undefined,
        to: undefined,
        search: undefined,
      },
      sort: { field: "createdAt", direction: "desc" },
      skip: 0,
      take: 20,
    });
    expect(result.items).toHaveLength(2);
    expect(result.meta).toEqual({ page: 1, limit: 20, total: 45, totalPages: 3 });
  });

  it("passes every filter through unchanged", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });
    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-01-31T23:59:59.999Z");

    await service.list(
      query({
        actorId: "11111111-1111-4111-8111-111111111111",
        action: "user.update",
        entity: "User",
        entityId: "user-9",
        from,
        to,
        search: "upd",
        page: 3,
        limit: 50,
      }),
    );

    expect(repo.list).toHaveBeenCalledWith({
      filters: {
        actorId: "11111111-1111-4111-8111-111111111111",
        action: "user.update",
        entity: "User",
        entityId: "user-9",
        from,
        to,
        search: "upd",
      },
      sort: { field: "createdAt", direction: "desc" },
      skip: 100,
      take: 50,
    });
  });

  it.each([
    ["createdAt", "asc"],
    ["createdAt:asc", "asc"],
    ["createdAt:desc", "desc"],
  ])("sorts %j as createdAt %s", async (sort, direction) => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.list(query({ sort }));

    expect(repo.list.mock.calls[0]?.[0].sort).toEqual({
      field: "createdAt",
      direction: direction === "asc" ? "asc" : "desc",
    });
  });

  it("falls back to the default sort for anything off the whitelist", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    await service.list(query({ sort: "action:asc" }));

    expect(repo.list.mock.calls[0]?.[0].sort).toEqual({ field: "createdAt", direction: "desc" });
  });

  it("reports one empty page when there are no entries", async () => {
    repo.list.mockResolvedValue({ rows: [], total: 0 });

    expect((await service.list(query())).meta).toEqual({ page: 1, limit: 20, total: 0, totalPages: 1 });
  });

  it("maps a missing actor to null and never includes before or after", async () => {
    const withExtras = {
      ...listRow({ actor: null }),
      before: { password: "x" },
      after: { a: 1 },
    } as AuditLogListRow;
    repo.list.mockResolvedValue({ rows: [withExtras], total: 1 });

    const [item] = (await service.list(query(), ctx)).items;

    expect(item?.actor).toBeNull();
    expect(item).not.toHaveProperty("before");
    expect(item).not.toHaveProperty("after");
    expect(Object.keys(item ?? {}).sort()).toEqual(
      [
        "action",
        "actionLabel",
        "actor",
        "createdAt",
        "entity",
        "entityCode",
        "entityDetail",
        "entityId",
        "entityName",
        "id",
        "ip",
        "requestId",
        "userAgent",
      ].sort(),
    );
  });
});

describe("mapper", () => {
  it("returns the time as a UTC ISO string", () => {
    expect(toListItemDto(listRow()).createdAt).toBe("2026-03-04T05:06:07.890Z");
  });

  it("keeps null metadata as null", () => {
    expect(
      toListItemDto(listRow({ entityId: null, ip: null, userAgent: null, requestId: null })),
    ).toMatchObject({
      entityId: null,
      ip: null,
      userAgent: null,
      requestId: null,
    });
  });

  it("masks sensitive values in before and after, keeping the keys, at any depth", () => {
    const dto = toDetailDto(
      detailRow({
        before: { name: "Old", passwordHash: "$2b$12$leak", sessions: [{ tokenHash: "abc", id: 1 }] },
        after: { name: "New", nested: { Authorization: "Bearer x", cookie: "sid=1", client_secret: "s" } },
      }),
    );

    expect(dto.before).toEqual({
      name: "Old",
      passwordHash: "[REDACTED]",
      sessions: [{ tokenHash: "[REDACTED]", id: 1 }],
    });
    expect(dto.after).toEqual({
      name: "New",
      nested: { Authorization: "[REDACTED]", cookie: "[REDACTED]", client_secret: "[REDACTED]" },
    });
    expect(JSON.stringify(dto)).not.toMatch(/\$2b\$|Bearer x|sid=1|"abc"/);
  });

  it("does not mask harmless keys and is idempotent on already-redacted data", () => {
    const once = toDetailDto(
      detailRow({ after: { author: "a", permissions: ["users:read"], passwordHash: "[REDACTED]" } }),
    );
    const twice = toDetailDto(detailRow({ after: once.after as AuditLogDetailRow["after"] }));

    expect(once.after).toEqual({ author: "a", permissions: ["users:read"], passwordHash: "[REDACTED]" });
    expect(twice.after).toEqual(once.after);
  });

  it("maps absent before and after to null, and a missing actor to null in the detail", () => {
    const dto = toDetailDto(detailRow({ before: null, after: null, actor: null }));

    expect(dto).toMatchObject({ before: null, after: null, actor: null });
  });
});

describe("get", () => {
  it("returns the full record with actor, before and after", async () => {
    repo.findById.mockResolvedValue(detailRow({ before: { name: "Old" }, after: { name: "Sara" } }));

    const dto = await service.get("log-1", ctx);

    expect(repo.findById).toHaveBeenCalledWith("log-1");
    expect(dto).toMatchObject({
      id: "log-1",
      actor: { id: "admin-1", name: "Root Admin", email: "root@example.test" },
      before: { name: "Old" },
      after: { name: "Sara" },
    });
  });

  it("answers 404 AUDIT_LOG_NOT_FOUND, translated", async () => {
    repo.findById.mockResolvedValue(null);

    const err = await service.get("missing", ctxAr).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      statusCode: 404,
      code: "AUDIT_LOG_NOT_FOUND",
      message: "سجل التدقيق غير موجود",
    });
  });
});

describe("filters", () => {
  it("returns what the repository found", async () => {
    const options = { actions: ["a"], entities: ["User"], actors: [{ id: "1", name: "N" }] };
    repo.filterOptions.mockResolvedValue(options);

    const filters = await service.filters(ctx);

    expect(filters.actors).toEqual(options.actors);
    // "a" is an action only the log holds; it is offered beside every action the application knows, and labelled by its code.
    expect(filters.actions).toEqual([...new Set([...KNOWN_ACTIONS, "a"])].sort());
    expect(filters.actionLabels["a"]).toBe("a");
    expect(filters.entities).toContain("User");
    expect(filters.entityLabels["User"]).toBe("User");
  });
});

describe("query validation", () => {
  const parse = (input: Record<string, unknown>) => listAuditLogsQuerySchema.safeParse(input);
  const messages = (input: Record<string, unknown>): { path: string; message: string }[] => {
    const result = parse(input);
    return result.success
      ? []
      : result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  };

  it("applies the shared pagination defaults", () => {
    const result = parse({});

    expect(result.success && result.data).toMatchObject({ page: 1, limit: 20 });
  });

  it("accepts a limit of 1000 and rejects 1001", () => {
    expect(parse({ limit: "1000" }).success).toBe(true);
    expect(parse({ limit: "1001" }).success).toBe(false);
  });

  it("reads a date alone as the whole UTC day: start for from, end for to", () => {
    const result = parse({ from: "2026-01-31", to: "2026-01-31" });

    expect(result.success && result.data.from?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(result.success && result.data.to?.toISOString()).toBe("2026-01-31T23:59:59.999Z");
  });

  it("takes a date and time as given and converts offsets to UTC", () => {
    const result = parse({ from: "2026-01-31T10:00:00+02:00", to: "2026-01-31T12:30:15.250Z" });

    expect(result.success && result.data.from?.toISOString()).toBe("2026-01-31T08:00:00.000Z");
    expect(result.success && result.data.to?.toISOString()).toBe("2026-01-31T12:30:15.250Z");
  });

  it.each(["2026-02-30", "2026-13-01", "31/01/2026", "2026-01-31T10:00:00", "yesterday", "", "2026-1-1"])(
    "rejects the invalid date %j with the dateInvalid key",
    (value) => {
      expect(messages({ from: value })).toEqual([{ path: "from", message: "validation.dateInvalid" }]);
      expect(messages({ to: value })).toEqual([{ path: "to", message: "validation.dateInvalid" }]);
    },
  );

  it("rejects from after to, on the to field", () => {
    expect(messages({ from: "2026-02-01", to: "2026-01-31" })).toEqual([
      { path: "to", message: "validation.dateRangeInvalid" },
    ]);
    expect(messages({ from: "2026-01-31T10:00:00Z", to: "2026-01-31T09:59:59.999Z" })).toHaveLength(1);
  });

  it("accepts from equal to to, and a single-day range written as dates", () => {
    expect(parse({ from: "2026-01-31T10:00:00Z", to: "2026-01-31T10:00:00Z" }).success).toBe(true);
    expect(parse({ from: "2026-01-31", to: "2026-01-31" }).success).toBe(true);
  });

  it("accepts only createdAt for sorting", () => {
    expect(parse({ sort: "createdAt:asc" }).success).toBe(true);
    for (const sort of ["action", "id:asc", "createdAt:up", "createdAt:asc:x", ":asc"]) {
      expect(messages({ sort })).toEqual([{ path: "sort", message: "validation.auditSortInvalid" }]);
    }
  });

  it("checks actorId is a uuid and limits the text filters to 100 characters", () => {
    expect(messages({ actorId: "nope" })).toEqual([{ path: "actorId", message: "validation.idInvalid" }]);
    expect(parse({ action: "x".repeat(100) }).success).toBe(true);
    expect(parse({ action: "x".repeat(101) }).success).toBe(false);
    expect(parse({ entity: "x".repeat(101) }).success).toBe(false);
    expect(parse({ entityId: "x".repeat(101) }).success).toBe(false);
    expect(messages({ search: "x".repeat(101) })).toEqual([
      { path: "search", message: "validation.searchTooLong" },
    ]);
  });
});
