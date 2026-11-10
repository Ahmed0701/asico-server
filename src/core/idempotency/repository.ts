import { randomUUID } from "node:crypto";
import { prisma } from "../database/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { IDEMPOTENCY_STALE_MS, IDEMPOTENCY_TTL_MS } from "./constants.js";

export { IDEMPOTENCY_STALE_MS, IDEMPOTENCY_TTL_MS };

export type ClaimParams = {
  userId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  now: Date;
};

// What claim() found. `owned` carries the lease: the claim's own timestamp, which complete() and release() must
// present, so a request that lost its claim to a takeover cannot overwrite the new owner's result.
export type Claim =
  | { kind: "owned"; id: string; lease: Date }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "mismatch" }
  | { kind: "in_progress" };

type Db = Prisma.TransactionClient | typeof prisma;

export class IdempotencyRepository {
  // Claims (userId, key) for one request. The insert is atomic (the unique index decides), so of any number of
  // simultaneous requests with the same key exactly one is `owned`.
  async claim(params: ClaimParams, db: Db = prisma): Promise<Claim> {
    const { userId, key, now } = params;
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = randomUUID();
      const inserted = await db.idempotencyKey.createMany({
        data: {
          id,
          key,
          userId,
          method: params.method,
          path: params.path,
          requestHash: params.requestHash,
          createdAt: now,
          expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
        },
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        return { kind: "owned", id, lease: now };
      }

      const existing = await db.idempotencyKey.findUnique({ where: { userId_key: { userId, key } } });
      if (!existing) {
        continue; // released between the insert and the read: try again
      }
      if (existing.expiresAt <= now) {
        await db.idempotencyKey.deleteMany({ where: { id: existing.id, expiresAt: { lte: now } } });
        continue;
      }
      if (existing.requestHash !== params.requestHash) {
        return { kind: "mismatch" };
      }
      if (existing.status === "COMPLETED" && existing.responseStatus !== null) {
        return { kind: "replay", status: existing.responseStatus, body: existing.responseBody };
      }
      const staleBefore = new Date(now.getTime() - IDEMPOTENCY_STALE_MS);
      if (existing.createdAt <= staleBefore) {
        const taken = await db.idempotencyKey.updateMany({
          where: { id: existing.id, status: "IN_PROGRESS", createdAt: existing.createdAt },
          data: { createdAt: now, expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS) },
        });
        if (taken.count === 1) {
          return { kind: "owned", id: existing.id, lease: now };
        }
        continue;
      }
      return { kind: "in_progress" };
    }
    return { kind: "in_progress" };
  }

  // Stores the response of the request that owns the claim.
  async complete(
    claim: { id: string; lease: Date },
    status: number,
    body: unknown,
    db: Db = prisma,
  ): Promise<boolean> {
    const { count } = await db.idempotencyKey.updateMany({
      where: { id: claim.id, status: "IN_PROGRESS", createdAt: claim.lease },
      data: {
        status: "COMPLETED",
        responseStatus: status,
        ...(body !== null && body !== undefined && { responseBody: body as Prisma.InputJsonValue }),
      },
    });
    return count === 1;
  }

  // Gives the key up, so the same one can be used again (the request failed, nothing was done).
  async release(claim: { id: string; lease: Date }, db: Db = prisma): Promise<void> {
    await db.idempotencyKey.deleteMany({
      where: { id: claim.id, status: "IN_PROGRESS", createdAt: claim.lease },
    });
  }

  // Housekeeping (scripts/purge-idempotency.ts): the rows past their 24 hours.
  async purgeExpired(now: Date = new Date(), db: Db = prisma): Promise<number> {
    const { count } = await db.idempotencyKey.deleteMany({ where: { expiresAt: { lte: now } } });
    return count;
  }
}
