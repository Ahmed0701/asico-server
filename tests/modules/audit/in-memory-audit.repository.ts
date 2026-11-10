import { randomUUID } from "node:crypto";
import type { Prisma } from "../../../src/generated/prisma/client.js";
import {
  MAX_FILTER_ACTORS,
  MAX_FILTER_VALUES,
  type AuditFilters,
  type AuditSort,
} from "../../../src/modules/audit/dto/audit.dto.js";
import type {
  AuditLogDetailRow,
  AuditLogListRow,
  AuditRepository,
} from "../../../src/modules/audit/repository/audit.repository.js";
import { actionCodes, canonicalAction } from "../../../src/modules/audit/dto/actions.js";
import {
  canonicalEntity,
  detailFromSnapshots,
  entityCodes,
  nameFromSnapshots,
} from "../../../src/modules/audit/dto/entities.js";
import { openWorkName } from "../../../src/modules/open-works/dto/open-works.dto.js";
import { toDay } from "../../../src/shared/utils/day.js";
import type { EntityNameRow, EntityRef } from "../../../src/modules/audit/repository/audit.repository.js";
import { store } from "../auth/in-memory-auth.repository.js";
import { engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { dailyLabourTables } from "../daily-labour/daily-labour-tables.js";
import { dailyReportTables } from "../daily-reports/daily-report-tables.js";
import { phaseTables } from "../elec-phases/in-memory-elec-phases.repository.js";
import { workItemTables } from "../open-works/work-item-tables.js";
import { siteReportTables } from "../site-reports/site-report-tables.js";
import { smallWorkTables } from "../small-works/small-work-tables.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";

export type StoredAuditRow = {
  id: string;
  createdAt: Date;
  actorId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

const rows = (): StoredAuditRow[] => store.auditRows as unknown as StoredAuditRow[];

// Adds a row straight to the shared fake table, with whatever timestamp and actor the test needs.
export function addAuditRow(
  overrides: Partial<StoredAuditRow> & { action: string; entity: string },
): StoredAuditRow {
  const row: StoredAuditRow = { id: randomUUID(), createdAt: new Date(), ...overrides };
  rows().push(row);
  return row;
}

function actorOf(row: StoredAuditRow): AuditLogListRow["actor"] {
  const user = store.users.find((candidate) => candidate.id === row.actorId);
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

function toListRow(row: StoredAuditRow): AuditLogListRow {
  return {
    id: row.id,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId ?? null,
    ip: row.ip ?? null,
    userAgent: row.userAgent ?? null,
    requestId: row.requestId ?? null,
    createdAt: row.createdAt,
    actor: actorOf(row),
  };
}

function matches(row: StoredAuditRow, f: AuditFilters): boolean {
  const needle = f.search?.toLowerCase();
  return (
    (!f.actorId || row.actorId === f.actorId) &&
    (!f.action || actionCodes(f.action).includes(row.action)) &&
    (!f.entity || entityCodes(f.entity).includes(row.entity)) &&
    (!f.entityId || row.entityId === f.entityId) &&
    (!f.from || row.createdAt >= f.from) &&
    (!f.to || row.createdAt <= f.to) &&
    (!needle || row.action.toLowerCase().includes(needle) || row.entity.toLowerCase().includes(needle))
  );
}

const sortedUnique = (values: string[]): string[] => [...new Set(values)].sort();

export class InMemoryAuditRepository implements AuditRepository {
  async list(params: { filters: AuditFilters; sort: AuditSort; skip: number; take: number }) {
    const direction = params.sort.direction === "asc" ? 1 : -1;
    const matching = rows()
      .filter((row) => matches(row, params.filters))
      .sort(
        (a, b) =>
          direction * (a.createdAt.getTime() - b.createdAt.getTime()) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    return {
      rows: matching.slice(params.skip, params.skip + params.take).map(toListRow),
      total: matching.length,
    };
  }

  async findById(id: string): Promise<AuditLogDetailRow | null> {
    const row = rows().find((candidate) => candidate.id === id);
    return row
      ? {
          ...toListRow(row),
          before: (row.before ?? null) as Prisma.JsonValue,
          after: (row.after ?? null) as Prisma.JsonValue,
        }
      : null;
  }

  async entityNames(entries: EntityNameRow[]): Promise<Map<string, string>> {
    const refs = await this.entityRefs(entries);
    return new Map([...refs].map(([id, ref]) => [id, ref.name]));
  }

  // The name of what each entry is about, and a user's email: the record as it is now, else the entry's own snapshot.
  async entityRefs(entries: EntityNameRow[]): Promise<Map<string, EntityRef>> {
    const live = (code: string, id: string): string | undefined => {
      switch (canonicalEntity(code)) {
        case "Villa":
          return villaTables.villas.find((p) => p.id === id)?.villaNumber;
        case "Contractor":
          return contractorTables.contractors.find((c) => c.id === id)?.name;
        case "CivilEngineer":
          return engineerTables.engineers.find((e) => e.id === id)?.name;
        case "User":
          return store.users.find((u) => u.id === id)?.name;
        case "VillaDocument":
          return villaTables.documents.find((f) => f.id === id)?.originalName;
        case "WorkItem": {
          const item = workItemTables.items.find((w) => w.id === id);
          const phase = phaseTables.phases.find((p) => p.id === item?.elecPhaseId);
          const villa = villaTables.villas.find((v) => v.id === item?.villaId);
          return item && phase && villa ? openWorkName(phase.name, villa.villaNumber) : undefined;
        }
        case "SiteReport":
          return siteReportTables.reports.find((r) => r.id === id)?.title;
        case "DailySmallWork":
          return smallWorkTables.works.find((w) => w.id === id)?.description;
        case "DailyReport": {
          const report = dailyReportTables.reports.find((r) => r.id === id);
          return report && toDay(report.reportDate);
        }
        case "DailyLabour": {
          const labour = dailyLabourTables.rows.find((r) => r.id === id);
          return labour && toDay(labour.labourDate);
        }
        default:
          return undefined;
      }
    };
    const refs = new Map<string, EntityRef>();
    for (const entry of entries) {
      if (entry.entityId === null) continue;
      const stored = rows().find((candidate) => candidate.id === entry.id);
      const name = live(entry.entity, entry.entityId);
      if (name) {
        const email =
          canonicalEntity(entry.entity) === "User"
            ? store.users.find((u) => u.id === entry.entityId)?.email
            : undefined;
        refs.set(entry.id, { name, detail: email ?? null });
        continue;
      }
      const snapshots = [entry.after ?? stored?.after, entry.before ?? stored?.before];
      const fromSnapshot = nameFromSnapshots(entry.entity, ...snapshots);
      if (fromSnapshot) {
        refs.set(entry.id, { name: fromSnapshot, detail: detailFromSnapshots(entry.entity, ...snapshots) });
      }
    }
    return refs;
  }

  async filterOptions() {
    const actorIds = new Set(rows().map((row) => row.actorId));
    return {
      actions: sortedUnique(rows().map((row) => canonicalAction(row.action))).slice(0, MAX_FILTER_VALUES),
      entities: sortedUnique(rows().map((row) => canonicalEntity(row.entity))).slice(0, MAX_FILTER_VALUES),
      actors: store.users
        .filter((user) => actorIds.has(user.id))
        .map((user) => ({ id: user.id, name: user.name }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .slice(0, MAX_FILTER_ACTORS),
    };
  }
}
