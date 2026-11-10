import type { Prisma } from "../../generated/prisma/client.js";
import { redact } from "./redact.js";

export type AuditEntry = {
  actorId?: string | null | undefined;
  action: string;
  entity: string;
  entityId?: string | undefined;
  before?: unknown;
  after?: unknown;
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
};

type AuditMeta = {
  ip?: string | undefined;
  userAgent?: string | undefined;
  requestId?: string | undefined;
};

// Adds the request's metadata (ip, user agent, request id) to an audit entry.
export function withMeta(meta: AuditMeta, entry: AuditEntry): AuditEntry {
  return { ...entry, ip: meta.ip, userAgent: meta.userAgent, requestId: meta.requestId };
}

function toJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  const redacted = redact(value);
  // A top-level JSON null would need Prisma.JsonNull; an absent snapshot is stored as SQL NULL instead.
  return redacted === null || redacted === undefined ? undefined : (redacted as Prisma.InputJsonValue);
}

// The columns of one audit row, from an entry.
function toData(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
  const before = toJsonInput(entry.before);
  const after = toJsonInput(entry.after);
  return {
    action: entry.action,
    entity: entry.entity,
    ...(entry.actorId != null && { actorId: entry.actorId }),
    ...(entry.entityId !== undefined && { entityId: entry.entityId }),
    ...(before !== undefined && { before }),
    ...(after !== undefined && { after }),
    ...(entry.ip !== undefined && { ip: entry.ip }),
    ...(entry.userAgent !== undefined && { userAgent: entry.userAgent }),
    ...(entry.requestId !== undefined && { requestId: entry.requestId }),
  };
}

// Append-only: these are the only write paths, and they always run in the caller's transaction,
// so the audit rows commit or roll back together with the change they describe.
export const audit = {
  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({ data: toData(entry) });
  },

  // Many entries in one statement, in the order given: for a change that makes hundreds of records at once (an import).
  async recordMany(tx: Prisma.TransactionClient, entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await tx.auditLog.createMany({ data: entries.map(toData) });
  },
};
