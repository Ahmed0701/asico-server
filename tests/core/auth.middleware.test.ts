import express from "express";
import { decodeJwt, SignJWT, UnsecuredJWT } from "jose";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  userPermission: { findFirst: vi.fn() },
}));
vi.mock("../../src/core/database/prisma.js", () => ({ prisma: db }));

import { env } from "../../src/core/config/env.js";
import { errorHandler } from "../../src/core/errors/errorHandler.js";
import { logger } from "../../src/core/config/logger.js";
import { auth } from "../../src/core/middleware/auth.js";
import { requestContext } from "../../src/core/middleware/requestContext.js";
import { requirePermission } from "../../src/core/middleware/requirePermission.js";
import {
  ExpiredAccessTokenError,
  InvalidAccessTokenError,
  signAccessToken,
  verifyAccessToken,
} from "../../src/core/security/jwt.js";
import { PERMISSIONS } from "../../src/shared/constants/permissions.js";

const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const now = () => Math.floor(Date.now() / 1000);

function claims(overrides: { sub?: string; iss?: string; exp?: number; alg?: string } = {}) {
  return new SignJWT({ role: "EMPLOYEE" })
    .setProtectedHeader({ alg: overrides.alg ?? "HS256" })
    .setSubject(overrides.sub ?? "user-1")
    .setIssuer(overrides.iss ?? "asico-server")
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? now() + 900);
}

describe("access tokens", () => {
  it("round-trips and expires after the configured lifetime", async () => {
    const token = await signAccessToken({ id: "user-1", role: "ADMIN" });

    await expect(verifyAccessToken(token)).resolves.toEqual({ userId: "user-1" });
    const payload = decodeJwt(token);
    expect(payload).toMatchObject({ sub: "user-1", role: "ADMIN", iss: "asico-server" });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(env.JWT_ACCESS_TTL_SECONDS);
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(900);
  });

  it.each([
    [
      "a tampered payload",
      async () => {
        const [header, , signature] = (await signAccessToken({ id: "user-1", role: "EMPLOYEE" })).split(".");
        const forged = Buffer.from(
          JSON.stringify({ sub: "admin", iss: "asico-server", exp: now() + 900 }),
        ).toString("base64url");
        return `${header}.${forged}.${signature}`;
      },
    ],
    [
      "another secret",
      () => claims().sign(new TextEncoder().encode("another-secret-another-secret-0123456789")),
    ],
    ["an expired token", () => claims({ exp: now() - 60 }).sign(secret)],
    ["another issuer", () => claims({ iss: "someone-else" }).sign(secret)],
    [
      "no subject",
      () =>
        new SignJWT({})
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("asico-server")
          .setExpirationTime("15m")
          .sign(secret),
    ],
    [
      "an unsigned (alg none) token",
      async () =>
        new UnsecuredJWT({ role: "ADMIN" })
          .setSubject("user-1")
          .setIssuer("asico-server")
          .setExpirationTime("15m")
          .encode(),
    ],
    ["a different algorithm", () => claims({ alg: "HS512" }).sign(secret)],
    ["garbage", async () => "not-a-jwt"],
  ])("rejects %s", async (_label, makeToken) => {
    await expect(verifyAccessToken(await makeToken())).rejects.toThrow();
  });
});

function appWith(...handlers: express.RequestHandler[]) {
  const app = express();
  app.use(requestContext);
  app.get("/probe", ...handlers, (req, res) => {
    res.json({ user: req.user });
  });
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  db.user.findUnique.mockReset();
  db.userPermission.findFirst.mockReset();
});

describe("auth middleware", () => {
  it("attaches the id and role read from the database, accepting any case of the Bearer scheme", async () => {
    db.user.findUnique.mockResolvedValue({ id: "user-1", role: "EMPLOYEE", isActive: true });
    const token = await signAccessToken({ id: "user-1", role: "ADMIN" });

    const res = await request(appWith(auth)).get("/probe").set("Authorization", `bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: "user-1", role: "EMPLOYEE" });
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { id: true, role: true, isActive: true },
    });
  });

  it.each([
    ["no header", undefined],
    ["a non-bearer scheme", "Basic abc"],
    ["a bare token", "abc"],
  ])("answers 401 for %s without querying the database", async (_label, header) => {
    const req = request(appWith(auth)).get("/probe");
    const res = await (header ? req.set("Authorization", header) : req);

    expect(res.status).toBe(401);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("answers 401 when the user is missing or inactive", async () => {
    const token = await signAccessToken({ id: "user-1", role: "EMPLOYEE" });
    db.user.findUnique.mockResolvedValueOnce(null);
    db.user.findUnique.mockResolvedValueOnce({ id: "user-1", role: "EMPLOYEE", isActive: false });

    const missing = await request(appWith(auth)).get("/probe").set("Authorization", `Bearer ${token}`);
    const inactive = await request(appWith(auth)).get("/probe").set("Authorization", `Bearer ${token}`);

    expect(missing.status).toBe(401);
    expect(inactive.status).toBe(401);
  });

  it("does not turn a database failure into a 401", async () => {
    db.user.findUnique.mockRejectedValue(new Error("connection refused"));
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const token = await signAccessToken({ id: "user-1", role: "EMPLOYEE" });

    const res = await request(appWith(auth)).get("/probe").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
  });
});

describe("an expired access token", () => {
  const expired = (sub = "user-1") => claims({ sub, exp: now() - 60 }).sign(secret);

  it("verifyAccessToken says it expired, which is a kind of invalid token", async () => {
    const err = await verifyAccessToken(await expired()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ExpiredAccessTokenError);
    expect(err).toBeInstanceOf(InvalidAccessTokenError);
  });

  it("is TOKEN_EXPIRED (401) without querying the database", async () => {
    const res = await request(appWith(auth))
      .get("/probe")
      .set("Authorization", `Bearer ${await expired()}`);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "TOKEN_EXPIRED", message: "Your access token has expired" });
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("is TOKEN_EXPIRED even for a user who has since been deactivated: expiry is judged before the user", async () => {
    db.user.findUnique.mockResolvedValue({ id: "user-1", role: "EMPLOYEE", isActive: false });

    const res = await request(appWith(auth))
      .get("/probe")
      .set("Authorization", `Bearer ${await expired()}`);

    expect(res.body.code).toBe("TOKEN_EXPIRED");
  });

  it("is judged by the clock: a token is valid up to its expiry and TOKEN_EXPIRED after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      db.user.findUnique.mockResolvedValue({ id: "user-1", role: "EMPLOYEE", isActive: true });
      const token = await signAccessToken({ id: "user-1", role: "EMPLOYEE" });

      vi.setSystemTime(Date.now() + (env.JWT_ACCESS_TTL_SECONDS - 1) * 1000);
      const before = await request(appWith(auth)).get("/probe").set("Authorization", `Bearer ${token}`);
      vi.setSystemTime(Date.now() + 2000);
      const after = await request(appWith(auth)).get("/probe").set("Authorization", `Bearer ${token}`);

      expect(before.status).toBe(200);
      expect(after.status).toBe(401);
      expect(after.body.code).toBe("TOKEN_EXPIRED");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["a token with no authorization at all", async () => undefined],
    ["garbage", async () => "not-a-jwt"],
    [
      "a tampered payload",
      async () => {
        const [header, , signature] = (await signAccessToken({ id: "user-1", role: "EMPLOYEE" })).split(".");
        const forged = Buffer.from(
          JSON.stringify({ sub: "x", iss: "asico-server", exp: now() - 60 }),
        ).toString("base64url");
        return `${header}.${forged}.${signature}`;
      },
    ],
    [
      "an expired token signed with another secret",
      () =>
        claims({ exp: now() - 60 }).sign(
          new TextEncoder().encode("another-secret-another-secret-0123456789"),
        ),
    ],
    [
      "an expired token from another issuer",
      () => claims({ iss: "someone-else", exp: now() - 60 }).sign(secret),
    ],
    ["an unexpired token from another issuer", () => claims({ iss: "someone-else" }).sign(secret)],
    [
      "a token with no subject",
      () =>
        new SignJWT({})
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("asico-server")
          .setExpirationTime("15m")
          .sign(secret),
    ],
  ])("%s stays UNAUTHORIZED", async (_label, makeToken) => {
    const token = await makeToken();
    const req = request(appWith(auth)).get("/probe");

    const res = await (token ? req.set("Authorization", `Bearer ${token}`) : req);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHORIZED");
  });

  it("a valid token for a missing or inactive user stays UNAUTHORIZED", async () => {
    db.user.findUnique.mockResolvedValue(null);
    const token = await signAccessToken({ id: "user-1", role: "EMPLOYEE" });

    const res = await request(appWith(auth)).get("/probe").set("Authorization", `Bearer ${token}`);

    expect(res.body.code).toBe("UNAUTHORIZED");
  });
});

describe("requirePermission", () => {
  const asUser =
    (user: { id: string; role: "ADMIN" | "EMPLOYEE" } | undefined): express.RequestHandler =>
    (req, _res, next) => {
      if (user) {
        req.user = user;
      }
      next();
    };

  it("answers 401 when no user was authenticated", async () => {
    const res = await request(appWith(asUser(undefined), requirePermission(PERMISSIONS.USERS_READ))).get(
      "/probe",
    );

    expect(res.status).toBe(401);
  });

  it("lets ADMIN through without a database lookup", async () => {
    const res = await request(
      appWith(asUser({ id: "a", role: "ADMIN" }), requirePermission(PERMISSIONS.USERS_READ)),
    ).get("/probe");

    expect(res.status).toBe(200);
    expect(db.userPermission.findFirst).not.toHaveBeenCalled();
  });

  it("asks the database for exactly this user and code, and allows when granted", async () => {
    db.userPermission.findFirst.mockResolvedValue({ userId: "e" });

    const res = await request(
      appWith(asUser({ id: "e", role: "EMPLOYEE" }), requirePermission(PERMISSIONS.USERS_READ)),
    ).get("/probe");

    expect(res.status).toBe(200);
    expect(db.userPermission.findFirst).toHaveBeenCalledWith({
      where: { userId: "e", permission: { code: "users:read" } },
      select: { userId: true },
    });
  });

  it("answers 403 FORBIDDEN, translated, when not granted", async () => {
    db.userPermission.findFirst.mockResolvedValue(null);

    const res = await request(
      appWith(asUser({ id: "e", role: "EMPLOYEE" }), requirePermission(PERMISSIONS.USERS_READ)),
    )
      .get("/probe")
      .set("Accept-Language", "ar");

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
  });
});
