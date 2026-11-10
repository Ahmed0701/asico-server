import type { Json } from "../../../core/audit/redact.js";
import type { PageMeta } from "../../../shared/query/pagination.js";

// Only createdAt can be sorted: the log is a timeline.
export const AUDIT_SORT_FIELDS = ["createdAt"] as const;
export type AuditSort = { field: (typeof AUDIT_SORT_FIELDS)[number]; direction: "asc" | "desc" };

// Bounds on the filter-dropdown lists, so the response stays small however large the log grows.
export const MAX_FILTER_ACTORS = 100;
export const MAX_FILTER_VALUES = 500;

export type AuditFilters = {
  actorId?: string | undefined;
  action?: string | undefined;
  entity?: string | undefined;
  entityId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  search?: string | undefined;
};

export type AuditActorDto = { id: string; name: string; email: string };

// `action` is the stable code that is stored (what the action filter takes) and `actionLabel` what it means in the language of the
// request. `entity` is the entity's label in the language of the request, `entityCode` the stable code it is stored under
// (what the entity filter takes). `entityName` is what the entry is about, by name: a villa's number, a
// contractor's, engineer's or user's name, a file's original name; null when none can be found. `entityDetail` is the
// second line that tells two of the same name apart, for the entities that have one: a user's email; null for the rest. Both
// come from the record while it exists and from the entry's own snapshot once it is gone.
export type AuditLogListItemDto = {
  id: string;
  actor: AuditActorDto | null;
  action: string;
  actionLabel: string;
  entity: string;
  entityCode: string;
  entityId: string | null;
  entityName: string | null;
  entityDetail: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  createdAt: string;
};

export type AuditLogDetailDto = AuditLogListItemDto & {
  before: Json | null;
  after: Json | null;
};

// `actions` and `entities` keep the raw codes (the filters take them); `actionLabels` and `entityLabels` name each one in the request
// language. Both lists hold every action and entity the application knows, whether or not an entry exists for it yet, and the
// ones only the log holds (an old one, or a new one this version does not know).
export type AuditFiltersDto = {
  actions: string[];
  actionLabels: Record<string, string>;
  entities: string[];
  entityLabels: Record<string, string>;
  actors: { id: string; name: string }[];
};

export type AuditLogListResult = { items: AuditLogListItemDto[]; meta: PageMeta };
