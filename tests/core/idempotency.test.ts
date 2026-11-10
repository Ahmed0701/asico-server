import express, { type RequestHandler } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  idempotencyTable,
  InMemoryIdempotencyRepository,
} from "../modules/write-safety/in-memory-idempotency.repository.js";

vi.mock("../../src/core/database/prisma.js", () => ({ prisma: {} }));

import { createHmac } from "node:crypto";
import { env } from "../../src/core/config/env.js";
import { logger } from "../../src/core/config/logger.js";
import { errorHandler } from "../../src/core/errors/errorHandler.js";
import {
  canonicalJson,
  idempotent,
  MAX_STORED_BODY_BYTES,
  requestHash,
  type IdempotencyOptions,
} from "../../src/core/idempotency/index.js";
import { requestContext } from "../../src/core/middleware/requestContext.js";

const KEY = "unit-test-key-0001";
const store = new InMemoryIdempotencyRepository() as never;

type Handler = (req: express.Request, res: express.Response) => void | Promise<void>;
function appWith(
  options: IdempotencyOptions = {},
  handler?: Handler,
  user: { id: string } | null = { id: "user-1" },
) {
  const app = express();
  app.use(requestContext);
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) req.user = { id: user.id, role: "EMPLOYEE" };
    next();
  });
  const calls = { count: 0 };
  const route: RequestHandler = async (req, res) => {
    calls.count += 1;
    if (handler) {
      await handler(req, res);
      return;
    }
    res.status(201).json({ data: { n: calls.count } });
  };
  app.post("/things", idempotent({ store, ...options }), route);
  app.delete("/things", idempotent({ store, ...options }), (_req, res) => {
    calls.count += 1;
    res.status(204).end();
  });
  app.use(errorHandler);
  return { app, calls };
}

beforeEach(() => {
  idempotencyTable.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const send = (app: express.Express, key: string | null = KEY, body: unknown = { a: 1 }) => {
  const req = request(app).post("/things");
  if (key !== null) req.set("Idempotency-Key", key);
  return req.send(body as object);
};

describe("canonicalJson and requestHash", () => {
  it("writes the same text whatever the order of the keys, at any depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: null } })).toBe(
      canonicalJson({ a: { c: null, d: [1, { y: 2, z: 1 }] }, b: 1 }),
    );
  });

  it("keeps the order of an array, and tells different values apart", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: "1" }));
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe(canonicalJson({ b: 1 }));
  });

  it("handles values that are not objects", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson([undefined])).toBe("[null]");
  });

  it("is a 64-character HMAC, the same for the same request and different for any change to it", () => {
    const base = { method: "POST", url: "/api/v1/things", body: { a: 1 } };

    expect(requestHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(requestHash(base)).toBe(requestHash({ ...base, body: { a: 1 } }));
    for (const changed of [
      { ...base, method: "PATCH" },
      { ...base, url: "/api/v1/things?x=1" },
      { ...base, body: { a: 2 } },
      { ...base, extra: "file-digest" },
    ]) {
      expect(requestHash(changed)).not.toBe(requestHash(base));
    }
  });

  it("is an HMAC keyed from the server's secret: the same request hashes differently under another secret", () => {
    const parts = { method: "POST", url: "/api/v1/things", body: { password: "hunter2" } };
    const key = createHmac("sha256", env.JWT_ACCESS_SECRET)
      .update("asico:idempotency:request-hash:v1")
      .digest();
    const expected = createHmac("sha256", key)
      .update(canonicalJson(["POST", "/api/v1/things", parts.body, null]))
      .digest("hex");

    expect(requestHash(parts)).toBe(expected);

    const original = env.JWT_ACCESS_SECRET;
    try {
      env.JWT_ACCESS_SECRET = "another-secret-another-secret-0123456789";
      expect(requestHash(parts)).not.toBe(expected);
    } finally {
      env.JWT_ACCESS_SECRET = original;
    }
  });

  it("treats a missing body and a null body alike, and an upload's extra input as part of the request", () => {
    const base = { method: "POST", url: "/x" };

    expect(requestHash({ ...base, body: undefined })).toBe(requestHash({ ...base, body: null }));
    expect(requestHash({ ...base, body: null, extra: "a" })).not.toBe(
      requestHash({ ...base, body: null, extra: "b" }),
    );
  });
});

describe("idempotent()", () => {
  it("passes a request without the header straight through", async () => {
    const { app, calls } = appWith();

    await send(app, null);
    await send(app, null);

    expect(calls.count).toBe(2);
    expect(idempotencyTable.rows).toHaveLength(0);
  });

  it("with required: true refuses a request without the header (400), and still accepts one with it", async () => {
    const { app, calls } = appWith({ required: true });

    const missing = await send(app, null);
    const present = await send(app);

    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(present.status).toBe(201);
    expect(calls.count).toBe(1);
  });

  it("with required: true the message follows the language of the request", async () => {
    const { app } = appWith({ required: true });

    const res = await request(app).post("/things").set("Accept-Language", "ar").send({});

    expect(res.body.message).toBe("ترويسة Idempotency-Key مطلوبة لهذا الطلب");
  });

  it("replays the status and the body, and the handler runs once", async () => {
    const { app, calls } = appWith();

    const first = await send(app);
    const second = await send(app);

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(calls.count).toBe(1);
  });

  it("stores and replays a response that has no body (204)", async () => {
    const { app, calls } = appWith();
    const del = () => request(app).delete("/things").set("Idempotency-Key", KEY);

    const first = await del();
    const second = await del();

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(calls.count).toBe(1);
  });

  it("accepts a 200 as well as a 201, and no other status below 300 is treated differently", async () => {
    const { app } = appWith({}, (_req, res) => void res.status(200).json({ data: "ok" }));

    await send(app);
    const second = await send(app);

    expect(second.status).toBe(200);
    expect(second.headers["idempotent-replayed"]).toBe("true");
  });

  it.each([400, 401, 403, 404, 409, 422, 429, 500, 502, 503])(
    "does not keep a %i: the key is free again",
    async (status) => {
      vi.spyOn(logger, "error").mockImplementation(() => undefined);
      let first = true;
      const { app, calls } = appWith({}, (_req, res) => {
        if (first) {
          first = false;
          res.status(status).json({ code: "NOPE" });
          return;
        }
        res.status(201).json({ data: "fine" });
      });

      const failed = await send(app);
      const retried = await send(app);

      expect(failed.status).toBe(status);
      expect(retried.status).toBe(201);
      expect(retried.headers["idempotent-replayed"]).toBeUndefined();
      expect(calls.count).toBe(2);
    },
  );

  it("gives the key back when the handler throws", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    let first = true;
    const { app } = appWith({}, () => {
      if (first) {
        first = false;
        throw new Error("boom");
      }
    });

    const failed = await send(app);

    expect(failed.status).toBe(500);
    expect(idempotencyTable.rows).toHaveLength(0);
  });

  it(`does not keep a response larger than ${MAX_STORED_BODY_BYTES} bytes, and gives the key back`, async () => {
    const big = "x".repeat(MAX_STORED_BODY_BYTES + 1);
    const { app, calls } = appWith({}, (_req, res) => void res.status(201).json({ data: big }));

    const first = await send(app);
    const second = await send(app);

    expect(first.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBeUndefined();
    expect(calls.count).toBe(2);
    expect(idempotencyTable.rows).toHaveLength(0);
  });

  it("keeps a response just under the limit", async () => {
    const nearly = "x".repeat(MAX_STORED_BODY_BYTES - 100);
    const { app, calls } = appWith({}, (_req, res) => void res.status(201).json({ data: nearly }));

    await send(app);
    const second = await send(app);

    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(calls.count).toBe(1);
  });

  it("needs a signed-in user: without one it answers 401 and stores nothing", async () => {
    const { app } = appWith({}, undefined, null);

    const res = await send(app);

    expect(res.status).toBe(401);
    expect(idempotencyTable.rows).toHaveLength(0);
  });

  it("does not fail the request when the answer cannot be stored: the client still gets it", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    idempotencyTable.failComplete = true;
    const { app } = appWith();

    const res = await send(app);

    expect(res.status).toBe(201);
    expect(idempotencyTable.rows).toHaveLength(0);
  });

  describe("the hooks for requests that carry more than JSON", () => {
    it("adds the fingerprint to the hash: same key, same body, another fingerprint is a different request", async () => {
      let fingerprint = "file-a";
      const { app, calls } = appWith({ fingerprint: () => fingerprint });

      await send(app);
      fingerprint = "file-b";
      const other = await send(app);

      expect(other.status).toBe(422);
      expect(calls.count).toBe(1);
      fingerprint = "file-a";
      expect((await send(app)).headers["idempotent-replayed"]).toBe("true");
    });

    it("calls discard whenever the request will not run: a replay, a conflict, a reused key, a bad key", async () => {
      const discard = vi.fn();
      const { app } = appWith({ discard });

      await send(app); // runs: nothing to discard
      expect(discard).not.toHaveBeenCalled();
      await send(app); // replay
      await send(app, KEY, { a: 2 }); // reused
      await send(app, "bad key"); // invalid
      expect(discard).toHaveBeenCalledTimes(3);
    });

    it("calls discard for a request refused as in progress", async () => {
      const discard = vi.fn();
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => (entered = resolve));
      const { app } = appWith({ discard }, async (_req, res) => {
        entered();
        await held;
        res.status(201).json({ data: 1 });
      });

      const running = send(app).then((res) => res);
      await reached;
      const during = await send(app);
      release();
      await running;

      expect(during.status).toBe(409);
      expect(discard).toHaveBeenCalledTimes(1);
    });

    it("does not let a failing discard hide the real answer", async () => {
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      const { app } = appWith({
        discard: () => {
          throw new Error("disk full");
        },
      });

      await send(app);
      const replay = await send(app);

      expect(replay.status).toBe(201);
      expect(replay.headers["idempotent-replayed"]).toBe("true");
    });
  });
});
