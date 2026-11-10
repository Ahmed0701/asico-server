import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "../../src/generated/prisma/client.js";

// If audit ever reached for the global client instead of the passed transaction, these spies would fire.
const globalClient = vi.hoisted(() => ({ auditLog: { create: vi.fn() }, $transaction: vi.fn() }));
vi.mock("../../src/core/database/prisma.js", () => ({ prisma: globalClient }));

import { audit } from "../../src/core/audit/audit.js";

const txCreate = vi.fn();
const txCreateMany = vi.fn();
const tx = {
  auditLog: { create: txCreate, createMany: txCreateMany },
} as unknown as Prisma.TransactionClient;

// Stands in for prisma.$transaction(callback): hands the callback a transaction client.
async function runInTransaction<T>(work: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return work(tx);
}

describe("audit.record", () => {
  beforeEach(() => {
    txCreate.mockReset();
    txCreateMany.mockReset();
    globalClient.auditLog.create.mockReset();
  });

  it("writes through the transaction client it was given, never the global one", async () => {
    await runInTransaction((client) => audit.record(client, { action: "user.create", entity: "User" }));

    expect(txCreate).toHaveBeenCalledTimes(1);
    expect(globalClient.auditLog.create).not.toHaveBeenCalled();
  });

  it("stores the full entry", async () => {
    await audit.record(tx, {
      actorId: "actor-1",
      action: "villa.update",
      entity: "Villa",
      entityId: "villa-1",
      before: { status: "OPEN" },
      after: { status: "CLOSED" },
      ip: "10.0.0.1",
      userAgent: "vitest",
      requestId: "req-1",
    });

    expect(txCreate).toHaveBeenCalledWith({
      data: {
        actorId: "actor-1",
        action: "villa.update",
        entity: "Villa",
        entityId: "villa-1",
        before: { status: "OPEN" },
        after: { status: "CLOSED" },
        ip: "10.0.0.1",
        userAgent: "vitest",
        requestId: "req-1",
      },
    });
  });

  it("redacts password and token fields from before and after", async () => {
    await audit.record(tx, {
      action: "user.update",
      entity: "User",
      before: { email: "a@x.test", passwordHash: "old-hash", sessions: [{ tokenHash: "t1" }] },
      after: { email: "b@x.test", password: "plain", nested: { resetToken: "r" } },
    });

    const { data } = txCreate.mock.calls[0]?.[0] as { data: { before: unknown; after: unknown } };
    expect(data.before).toEqual({
      email: "a@x.test",
      passwordHash: "[REDACTED]",
      sessions: [{ tokenHash: "[REDACTED]" }],
    });
    expect(data.after).toEqual({
      email: "b@x.test",
      password: "[REDACTED]",
      nested: { resetToken: "[REDACTED]" },
    });
    expect(JSON.stringify(txCreate.mock.calls)).not.toMatch(/old-hash|plain|"t1"/);
  });

  it("omits absent optional fields instead of writing undefined or null", async () => {
    await audit.record(tx, {
      action: "auth.login",
      entity: "User",
      actorId: null,
      before: null,
      after: undefined,
    });

    expect(txCreate).toHaveBeenCalledWith({ data: { action: "auth.login", entity: "User" } });
  });

  it("lets a failing write reject, so the surrounding transaction can roll back", async () => {
    txCreate.mockRejectedValue(new Error("db down"));

    await expect(audit.record(tx, { action: "x", entity: "Y" })).rejects.toThrow("db down");
  });

  it("is append-only by construction: it exposes only operations that add rows", () => {
    expect(Object.keys(audit)).toEqual(["record", "recordMany"]);
  });
});

describe("audit.recordMany", () => {
  beforeEach(() => {
    txCreate.mockReset();
    txCreateMany.mockReset();
  });

  it("writes every entry in one statement, in the order given, with the columns record writes", async () => {
    const entries = [
      {
        actorId: "a1",
        action: "villa.create",
        entity: "Villa",
        entityId: "v1",
        after: { villaNumber: "V-1" },
        ip: "10.0.0.1",
        userAgent: "ua",
        requestId: "r1",
      },
      {
        actorId: null,
        action: "villa.create",
        entity: "Villa",
        entityId: "v2",
        after: { password: "plain" },
      },
    ];

    await audit.recordMany(tx, entries);

    expect(txCreateMany).toHaveBeenCalledTimes(1);
    expect(txCreate).not.toHaveBeenCalled();
    expect(txCreateMany).toHaveBeenCalledWith({
      data: [
        {
          actorId: "a1",
          action: "villa.create",
          entity: "Villa",
          entityId: "v1",
          after: { villaNumber: "V-1" },
          ip: "10.0.0.1",
          userAgent: "ua",
          requestId: "r1",
        },
        { action: "villa.create", entity: "Villa", entityId: "v2", after: { password: "[REDACTED]" } },
      ],
    });
  });

  it("writes the same row for an entry as record does", async () => {
    const entry = { actorId: "a1", action: "x.y", entity: "Z", before: { token: "t" }, after: { ok: 1 } };

    await audit.record(tx, entry);
    await audit.recordMany(tx, [entry]);

    expect((txCreateMany.mock.calls[0]?.[0] as { data: unknown[] }).data[0]).toEqual(
      (txCreate.mock.calls[0]?.[0] as { data: unknown }).data,
    );
  });

  it("writes nothing, and makes no call, for no entries", async () => {
    await audit.recordMany(tx, []);

    expect(txCreateMany).not.toHaveBeenCalled();
  });

  it("lets a failing write reject, so the surrounding transaction can roll back", async () => {
    txCreateMany.mockRejectedValue(new Error("db down"));

    await expect(audit.recordMany(tx, [{ action: "x", entity: "Y" }])).rejects.toThrow("db down");
  });
});
