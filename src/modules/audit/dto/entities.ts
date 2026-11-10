import type { MessageKey } from "../../../core/i18n/index.js";
import { t } from "../../../core/i18n/index.js";
import type { LocaleCode } from "../../../shared/constants/enums.js";

// The entities that audit entries are written about. The code is what is stored (and what the entity filter
// takes); the label, in the language of the request, is what a person reads.
export const ENTITY_LABEL_KEYS = {
  User: "entities.User",
  Villa: "entities.Villa",
  Contractor: "entities.Contractor",
  CivilEngineer: "entities.CivilEngineer",
  ElectricalEngineer: "entities.ElectricalEngineer",
  ElecPhase: "entities.ElecPhase",
  Area: "entities.Area",
  VillaDocument: "entities.VillaDocument",
  WorkItem: "entities.WorkItem",
  DailyReport: "entities.DailyReport",
  DailySmallWork: "entities.DailySmallWork",
  SiteReport: "entities.SiteReport",
  DailyLabour: "entities.DailyLabour",
  MaintenanceVilla: "entities.MaintenanceVilla",
  Factory: "entities.Factory",
  MaterialDelivery: "entities.MaterialDelivery",
  MaterialItem: "entities.MaterialItem",
  AuditLog: "entities.AuditLog",
} as const satisfies Record<string, MessageKey>;

export type AuditEntity = keyof typeof ENTITY_LABEL_KEYS;

export function isAuditEntity(code: string): code is AuditEntity {
  return Object.hasOwn(ENTITY_LABEL_KEYS, code);
}

// Entries written before the villa rename keep the codes they were written under (the log is append-only). Each
// is the same record kind as today's entity, so it is labelled, named and filtered as that entity.
export const LEGACY_ENTITIES = {
  Project: "Villa",
  ProjectFile: "VillaDocument",
} as const satisfies Record<string, AuditEntity>;

export type LegacyEntity = keyof typeof LEGACY_ENTITIES;

function isLegacyEntity(code: string): code is LegacyEntity {
  return Object.hasOwn(LEGACY_ENTITIES, code);
}

// The entity an entry's code stands for today; a code that is not a legacy one is its own.
export function canonicalEntity(code: string): string {
  return isLegacyEntity(code) ? LEGACY_ENTITIES[code] : code;
}

// Every code stored for an entity: the entity filter takes any of them and matches all.
export function entityCodes(code: string): string[] {
  const canonical = canonicalEntity(code);
  return [
    canonical,
    ...Object.keys(LEGACY_ENTITIES).filter((legacy) => canonicalEntity(legacy) === canonical),
  ];
}

// An entity this list does not know (a new one, or an old one) keeps its code as its label.
export function entityLabel(code: string, locale: LocaleCode): string {
  const canonical = canonicalEntity(code);
  return isAuditEntity(canonical) ? t(locale, ENTITY_LABEL_KEYS[canonical]) : code;
}

// The field that names each entity: a villa has a number rather than a name.
export const NAME_FIELD: Record<AuditEntity, string | undefined> = {
  User: "name",
  Villa: "villaNumber",
  Contractor: "name",
  CivilEngineer: "name",
  ElectricalEngineer: "name",
  ElecPhase: "name",
  Area: "name",
  VillaDocument: "originalName",
  WorkItem: "name",
  DailyReport: "reportDate",
  DailySmallWork: "description",
  SiteReport: "title",
  DailyLabour: "labourDate",
  MaintenanceVilla: "villaNumber",
  Factory: "name",
  MaterialDelivery: "noteNumber",
  MaterialItem: "name",
  AuditLog: undefined,
};

// Snapshots written before slice 19 name an open work by its title, which no longer exists.
const OLDER_NAME_FIELD: Partial<Record<AuditEntity, string>> = {
  WorkItem: "title",
};

// What tells apart two entries of the same name, for the entities that have one: a user's email. Everything else is
// named by one field alone.
export const DETAIL_FIELD: Partial<Record<AuditEntity, string>> = {
  User: "email",
};

// Old snapshots hold the fields as they were then: a project had a projectNumber.
const LEGACY_NAME_FIELD: Record<LegacyEntity, string> = {
  Project: "projectNumber",
  ProjectFile: "originalName",
};

function nameFieldOf(entity: string): string | undefined {
  if (isLegacyEntity(entity)) return LEGACY_NAME_FIELD[entity];
  return isAuditEntity(entity) ? NAME_FIELD[entity] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The text a field holds in the first snapshot that has some.
function fromSnapshots(field: string | undefined, snapshots: unknown[]): string | null {
  if (!field) {
    return null;
  }
  for (const snapshot of snapshots) {
    const value = isRecord(snapshot) ? snapshot[field] : undefined;
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return null;
}

// The name an entry's own before/after snapshot holds, the first snapshot that has one. Used when the record
// itself is gone, which is what a delete leaves behind.
export function nameFromSnapshots(entity: string, ...snapshots: unknown[]): string | null {
  const older = isAuditEntity(entity) ? OLDER_NAME_FIELD[entity] : undefined;
  return fromSnapshots(nameFieldOf(entity), snapshots) ?? fromSnapshots(older, snapshots);
}

// The same for the detail of an entity that has one (a user's email); null for every other entity.
export function detailFromSnapshots(entity: string, ...snapshots: unknown[]): string | null {
  return fromSnapshots(isAuditEntity(entity) ? DETAIL_FIELD[entity] : undefined, snapshots);
}
