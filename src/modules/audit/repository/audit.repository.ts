import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { cleanWhere, escapeLike } from "../../../shared/query/where.js";
import { MAX_FILTER_ACTORS, MAX_FILTER_VALUES, type AuditFilters, type AuditSort } from "../dto/audit.dto.js";
import { actionCodes, canonicalAction } from "../dto/actions.js";
import { toDay } from "../../../shared/utils/day.js";
import { canonicalEntity, detailFromSnapshots, entityCodes, nameFromSnapshots } from "../dto/entities.js";
import { openWorkName } from "../../open-works/dto/open-works.dto.js";

export type Db = Prisma.TransactionClient;

const actorSelect = { select: { id: true, name: true, email: true } } as const;

// The list never loads before/after: they can be large and are only shown on the detail view.
export const auditLogListSelect = {
  id: true,
  action: true,
  entity: true,
  entityId: true,
  ip: true,
  userAgent: true,
  requestId: true,
  createdAt: true,
  actor: actorSelect,
} satisfies Prisma.AuditLogSelect;

const detailSelect = { ...auditLogListSelect, before: true, after: true } satisfies Prisma.AuditLogSelect;

export type AuditLogListRow = Prisma.AuditLogGetPayload<{ select: typeof auditLogListSelect }>;
export type AuditLogDetailRow = Prisma.AuditLogGetPayload<{ select: typeof detailSelect }>;

type ListParams = { filters: AuditFilters; sort: AuditSort; skip: number; take: number };

// What is needed to find the name of the thing an entry is about. `before` and `after` are optional: where the
// caller already has them (the detail view) they are used, and otherwise they are only fetched if they are needed.
export type EntityNameRow = {
  id: string;
  entity: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
};

// What an entry is about: its name, and for the entities that have one the second line that tells two of the same name apart.
export type EntityRef = { name: string; detail: string | null };

type NamedRecord = { id: string; name: string; detail?: string };

// One query per kind of entity, for all of its ids at once. A villa is named by its number.
const LIVE_NAMES: Record<string, (db: Db, ids: string[]) => Promise<NamedRecord[]>> = {
  Villa: async (db, ids) =>
    (await db.villa.findMany({ where: { id: { in: ids } }, select: { id: true, villaNumber: true } })).map(
      (row) => ({ id: row.id, name: row.villaNumber }),
    ),
  Contractor: (db, ids) =>
    db.contractor.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  CivilEngineer: (db, ids) =>
    db.civilEngineer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ElectricalEngineer: (db, ids) =>
    db.electricalEngineer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  ElecPhase: (db, ids) =>
    db.elecPhase.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  Area: (db, ids) => db.area.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
  // A user is named by their name, and told apart by their email.
  User: async (db, ids) =>
    (
      await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true } })
    ).map((row) => ({ id: row.id, name: row.name, detail: row.email })),
  VillaDocument: async (db, ids) =>
    (
      await db.villaDocument.findMany({
        where: { id: { in: ids } },
        select: { id: true, originalName: true },
      })
    ).map((row) => ({ id: row.id, name: row.originalName })),
  // A small work and a site report are named by their description or title. An open work has no title: it is named by its
  // electrical phase and its villa (see openWorkName). A daily report and a labour entry have no name of their own: they are
  // named by their day (YYYY-MM-DD), as their snapshots name them.
  WorkItem: async (db, ids) =>
    (
      await db.workItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, elecPhase: { select: { name: true } }, villa: { select: { villaNumber: true } } },
      })
    ).map((row) => ({ id: row.id, name: openWorkName(row.elecPhase.name, row.villa.villaNumber) })),
  SiteReport: async (db, ids) =>
    (await db.siteReport.findMany({ where: { id: { in: ids } }, select: { id: true, title: true } })).map(
      (row) => ({ id: row.id, name: row.title }),
    ),
  DailySmallWork: async (db, ids) =>
    (
      await db.dailySmallWork.findMany({
        where: { id: { in: ids } },
        select: { id: true, description: true },
      })
    ).map((row) => ({ id: row.id, name: row.description })),
  DailyReport: async (db, ids) =>
    (
      await db.dailyReport.findMany({ where: { id: { in: ids } }, select: { id: true, reportDate: true } })
    ).map((row) => ({ id: row.id, name: toDay(row.reportDate) })),
  DailyLabour: async (db, ids) =>
    (
      await db.dailyLabour.findMany({ where: { id: { in: ids } }, select: { id: true, labourDate: true } })
    ).map((row) => ({ id: row.id, name: toDay(row.labourDate) })),
};

const refKey = (entity: string, id: string): string => `${entity}:${id}`;

function whereOf({
  actorId,
  action,
  entity,
  entityId,
  from,
  to,
  search,
}: AuditFilters): Prisma.AuditLogWhereInput {
  // cleanWhere has already dropped the filters that were not sent, so the cast only removes `| undefined`.
  const exact = cleanWhere({ actorId, entityId }) as Prisma.AuditLogWhereInput;
  // Entries written before the villa rename carry the old codes; the action and entity filters match those as well.
  const byAction = action ? { action: { in: actionCodes(action) } } : {};
  const byEntity = entity ? { entity: { in: entityCodes(entity) } } : {};
  const createdAt = from || to ? { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {};
  if (!search) {
    return { ...exact, ...byAction, ...byEntity, ...createdAt };
  }
  const term = escapeLike(search);
  return {
    ...exact,
    ...byAction,
    ...byEntity,
    ...createdAt,
    OR: [
      { action: { contains: term, mode: "insensitive" } },
      { entity: { contains: term, mode: "insensitive" } },
    ],
  };
}

// Read-only on purpose: the audit log is append-only and this module never writes to it.
export class AuditRepository {
  async list(
    { filters, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: AuditLogListRow[]; total: number }> {
    const where = whereOf(filters);
    // `id` breaks ties so pages never repeat or skip rows that share a timestamp.
    const [rows, total] = await Promise.all([
      db.auditLog.findMany({
        where,
        select: auditLogListSelect,
        orderBy: [{ createdAt: sort.direction }, { id: "asc" }],
        skip,
        take,
      }),
      db.auditLog.count({ where }),
    ]);
    return { rows, total };
  }

  // The name of the thing each entry is about, by entry id: entityRefs without the detail.
  async entityNames(rows: EntityNameRow[], db: Db = prisma): Promise<Map<string, string>> {
    const refs = await this.entityRefs(rows, db);
    return new Map([...refs].map(([id, ref]) => [id, ref.name]));
  }

  // The name of the thing each entry is about, by entry id. It is read from the record as it is now (at most one
  // query per kind of entity, however many entries there are). If the record is gone, as after a delete, the entry's
  // own snapshot is used, fetched once for all such entries. Entries with no name found are left out. An entry
  // written under a legacy code is looked up as the entity it stands for today.
  async entityRefs(rows: EntityNameRow[], db: Db = prisma): Promise<Map<string, EntityRef>> {
    const idsByEntity = new Map<string, Set<string>>();
    for (const row of rows) {
      const kind = canonicalEntity(row.entity);
      if (row.entityId !== null && LIVE_NAMES[kind]) {
        idsByEntity.set(kind, (idsByEntity.get(kind) ?? new Set()).add(row.entityId));
      }
    }

    const live = new Map<string, NamedRecord>();
    await Promise.all(
      [...idsByEntity].map(async ([entity, ids]) => {
        for (const record of (await LIVE_NAMES[entity]?.(db, [...ids])) ?? []) {
          live.set(refKey(entity, record.id), record);
        }
      }),
    );

    const refs = new Map<string, EntityRef>();
    const gone: EntityNameRow[] = [];
    for (const row of rows) {
      const kind = canonicalEntity(row.entity);
      const record = row.entityId === null ? undefined : live.get(refKey(kind, row.entityId));
      if (record !== undefined) {
        refs.set(row.id, { name: record.name, detail: record.detail ?? null });
      } else if (row.entityId !== null && LIVE_NAMES[kind]) {
        gone.push(row);
      }
    }

    const needFetch = gone.filter((row) => row.before === undefined && row.after === undefined);
    const fetched =
      needFetch.length === 0
        ? []
        : await db.auditLog.findMany({
            where: { id: { in: needFetch.map((row) => row.id) } },
            select: { id: true, before: true, after: true },
          });
    const snapshots = new Map(fetched.map((row) => [row.id, row]));
    for (const row of gone) {
      const snapshot = snapshots.get(row.id);
      const held = [row.after ?? snapshot?.after, row.before ?? snapshot?.before];
      const name = nameFromSnapshots(row.entity, ...held);
      if (name !== null) {
        refs.set(row.id, { name, detail: detailFromSnapshots(row.entity, ...held) });
      }
    }
    return refs;
  }

  findById(id: string, db: Db = prisma): Promise<AuditLogDetailRow | null> {
    return db.auditLog.findUnique({ where: { id }, select: detailSelect });
  }

  // Values for the filter dropdowns. GROUP BY runs in the database; the caps keep the payload bounded.
  async filterOptions(
    db: Db = prisma,
  ): Promise<{ actions: string[]; entities: string[]; actors: { id: string; name: string }[] }> {
    const [actions, entities, actors] = await Promise.all([
      db.auditLog.groupBy({ by: ["action"], orderBy: { action: "asc" }, take: MAX_FILTER_VALUES }),
      db.auditLog.groupBy({ by: ["entity"], orderBy: { entity: "asc" }, take: MAX_FILTER_VALUES }),
      db.user.findMany({
        where: { auditLogs: { some: {} } },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: MAX_FILTER_ACTORS,
      }),
    ]);
    return {
      // One code per action and per entity: the legacy codes are folded into the one they stand for.
      actions: [...new Set(actions.map((row) => canonicalAction(row.action)))].sort(),
      entities: [...new Set(entities.map((row) => canonicalEntity(row.entity)))].sort(),
      actors,
    };
  }
}
