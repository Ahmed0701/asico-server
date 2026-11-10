import { randomUUID } from "node:crypto";
import { IDEMPOTENCY_STALE_MS, IDEMPOTENCY_TTL_MS } from "../../../src/core/idempotency/constants.js";
import type { Claim, ClaimParams, IdempotencyRepository } from "../../../src/core/idempotency/repository.js";

export type StoredKey = {
  id: string;
  key: string;
  userId: string;
  method: string;
  path: string;
  requestHash: string;
  status: "IN_PROGRESS" | "COMPLETED";
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: Date;
  expiresAt: Date;
};

// Plain-memory stand-in for the IdempotencyKey table. Every method runs to the end without waiting, so each one is
// atomic, as the database's unique index and single-statement updates make the real ones.
export const idempotencyTable = {
  rows: [] as StoredKey[],
  failComplete: false,
  // Storing a response takes this long, as a database round trip does.
  completeDelayMs: 0,

  reset(): void {
    this.rows = [];
    this.failComplete = false;
    this.completeDelayMs = 0;
  },
};

export class InMemoryIdempotencyRepository implements Pick<
  IdempotencyRepository,
  "claim" | "complete" | "release" | "purgeExpired"
> {
  async claim(params: ClaimParams): Promise<Claim> {
    const { userId, key, now } = params;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!idempotencyTable.rows.some((row) => row.userId === userId && row.key === key)) {
        const row: StoredKey = {
          id: randomUUID(),
          key,
          userId,
          method: params.method,
          path: params.path,
          requestHash: params.requestHash,
          status: "IN_PROGRESS",
          responseStatus: null,
          responseBody: null,
          createdAt: now,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        };
        idempotencyTable.rows.push(row);
        return { kind: "owned", id: row.id, lease: now };
      }
      const existing = idempotencyTable.rows.find((row) => row.userId === userId && row.key === key)!;
      if (existing.expiresAt <= now) {
        idempotencyTable.rows = idempotencyTable.rows.filter((row) => row.id !== existing.id);
        continue;
      }
      if (existing.requestHash !== params.requestHash) {
        return { kind: "mismatch" };
      }
      if (existing.status === "COMPLETED" && existing.responseStatus !== null) {
        return { kind: "replay", status: existing.responseStatus, body: existing.responseBody };
      }
      if (existing.createdAt.getTime() <= now.getTime() - IDEMPOTENCY_STALE_MS) {
        existing.createdAt = now;
        existing.expiresAt = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
        return { kind: "owned", id: existing.id, lease: now };
      }
      return { kind: "in_progress" };
    }
    return { kind: "in_progress" };
  }

  async complete(claim: { id: string; lease: Date }, status: number, body: unknown): Promise<boolean> {
    if (idempotencyTable.completeDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, idempotencyTable.completeDelayMs));
    }
    if (idempotencyTable.failComplete) {
      throw new Error("database went away");
    }
    const row = idempotencyTable.rows.find(
      (candidate) =>
        candidate.id === claim.id &&
        candidate.status === "IN_PROGRESS" &&
        candidate.createdAt.getTime() === claim.lease.getTime(),
    );
    if (!row) {
      return false;
    }
    row.status = "COMPLETED";
    row.responseStatus = status;
    row.responseBody = body ?? null;
    return true;
  }

  async release(claim: { id: string; lease: Date }): Promise<void> {
    idempotencyTable.rows = idempotencyTable.rows.filter(
      (row) =>
        !(
          row.id === claim.id &&
          row.status === "IN_PROGRESS" &&
          row.createdAt.getTime() === claim.lease.getTime()
        ),
    );
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    const before = idempotencyTable.rows.length;
    idempotencyTable.rows = idempotencyTable.rows.filter((row) => row.expiresAt > now);
    return before - idempotencyTable.rows.length;
  }
}
