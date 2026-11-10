import bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import express from "express";
import { SignJWT } from "jose";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "./in-memory-auth.repository.js";
import { RecordingMailer, tokenIn } from "./recording-mailer.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("./in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/auth/repository/auth.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/auth/repository/auth.repository.js")>()),
  AuthRepository: (await import("./in-memory-auth.repository.js")).InMemoryAuthRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import { setMailer } from "../../../src/core/mail/index.js";
import { errorHandler } from "../../../src/core/errors/errorHandler.js";
import { auth } from "../../../src/core/middleware/auth.js";
import { requestContext } from "../../../src/core/middleware/requestContext.js";
import { requirePermission } from "../../../src/core/middleware/requirePermission.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import { PERMISSION_CODES, PERMISSIONS } from "../../../src/shared/constants/permissions.js";

const PASSWORD = "Correct-Horse-9";
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const app = createApp();

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 12);
});

beforeEach(() => {
  store.reset();
});

afterEach(() => {
  env.NODE_ENV = "test";
  vi.restoreAllMocks();
});

function seedEmployee(overrides = {}) {
  return store.addUser({ email: "sara@example.test", name: "Sara", passwordHash, ...overrides });
}

function cookieHeader(res: request.Response): string | undefined {
  const cookies = res.headers["set-cookie"] as unknown as string[] | undefined;
  return cookies?.find((cookie) => cookie.startsWith("refresh_token="));
}

function refreshTokenOf(res: request.Response): string {
  const header = cookieHeader(res);
  if (!header) {
    throw new Error("no refresh_token cookie was set");
  }
  return decodeURIComponent((header.split(";")[0] ?? "").slice("refresh_token=".length));
}

// Makes a token look as if it had been rotated `ms` ago (a replay inside the grace window is a 409, not reuse).
function rotatedAgo(token: string, ms: number): void {
  const row = store.refreshTokens.find((candidate) => candidate.tokenHash === sha256(token));
  if (row?.revokedAt) {
    row.revokedAt = new Date(Date.now() - ms);
  }
}

async function login(email = "sara@example.test", password = PASSWORD): Promise<request.Response> {
  return request(app).post("/api/v1/auth/login").send({ email, password });
}

const bearer = async (user: {
  id: string;
  role: "ADMIN" | "EMPLOYEE";
}): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken(user)}`,
});

describe("authentication (401)", () => {
  it("rejects a request with no token", async () => {
    const res = await request(app).get("/api/v1/me");

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  it("answers in Arabic when asked", async () => {
    const res = await request(app).get("/api/v1/me").set("Accept-Language", "ar");

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("غير مصرح");
  });

  it.each([
    ["a malformed header", "Token abc"],
    ["a garbage token", "Bearer not.a.jwt"],
    ["two tokens", "Bearer a b"],
  ])("rejects %s", async (_label, header) => {
    const res = await request(app).get("/api/v1/me").set("Authorization", header);

    expect(res.status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const user = seedEmployee();
    const expired = await new SignJWT({ role: "EMPLOYEE" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("asico-server")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(env.JWT_ACCESS_SECRET));

    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${expired}`);

    expect(res.status).toBe(401);
    // Its own code, so a client knows to refresh instead of signing the user out.
    expect(res.body).toMatchObject({ code: "TOKEN_EXPIRED", message: "Your access token has expired" });
    expect(res.body.requestId).toEqual(expect.any(String));

    const ar = await request(app)
      .get("/api/v1/me")
      .set("Accept-Language", "ar")
      .set("Authorization", `Bearer ${expired}`);
    expect(ar.status).toBe(401);
    expect(ar.body.code).toBe("TOKEN_EXPIRED");
    expect(ar.body.message).toBe("انتهت صلاحية رمز الوصول");
  });

  it("rejects a token signed with a different secret", async () => {
    const user = seedEmployee();
    const forged = await new SignJWT({ role: "ADMIN" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuer("asico-server")
      .setExpirationTime("15m")
      .sign(new TextEncoder().encode("a-completely-different-secret-0123456789"));

    const res = await request(app).get("/api/v1/me").set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(401);
  });

  it("rejects a valid token whose user was deleted or deactivated since", async () => {
    const gone = seedEmployee({ email: "gone@example.test" });
    const inactive = seedEmployee({ email: "off@example.test" });
    const goneHeader = await bearer(gone);
    const inactiveHeader = await bearer(inactive);
    store.users = store.users.filter((user) => user.id !== gone.id);
    inactive.isActive = false;

    expect((await request(app).get("/api/v1/me").set(goneHeader)).status).toBe(401);
    expect((await request(app).get("/api/v1/me").set(inactiveHeader)).status).toBe(401);
  });

  it("uses the role stored in the database, not the one in the token", async () => {
    const user = seedEmployee();
    const header = await bearer({ id: user.id, role: "ADMIN" });

    const res = await request(app).get("/api/v1/me").set(header);

    expect(res.body.data.role).toBe("EMPLOYEE");
    expect(res.body.data.permissions).toEqual([]);
  });
});

describe("permission guard (403)", () => {
  const guarded = express();
  guarded.use(requestContext);
  guarded.get("/needs-read", auth, requirePermission(PERMISSIONS.VILLAS_READ), (_req, res) => {
    res.json({ ok: true });
  });
  guarded.use(errorHandler);

  it("lets ADMIN through without any granted permission", async () => {
    const admin = store.addUser({ email: "root@example.test", passwordHash, role: "ADMIN" });

    const res = await request(guarded)
      .get("/needs-read")
      .set(await bearer(admin));

    expect(res.status).toBe(200);
  });

  it("lets an EMPLOYEE through only with the code granted", async () => {
    const employee = seedEmployee();
    const header = await bearer(employee);

    const denied = await request(guarded).get("/needs-read").set(header).set("Accept-Language", "ar");
    store.grant(employee.id, PERMISSIONS.VILLAS_READ);
    const allowed = await request(guarded).get("/needs-read").set(header);

    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    expect(allowed.status).toBe(200);
  });

  it("does not let a different code stand in", async () => {
    const employee = seedEmployee();
    store.grant(employee.id, PERMISSIONS.VILLAS_CREATE);

    const res = await request(guarded)
      .get("/needs-read")
      .set(await bearer(employee));

    expect(res.status).toBe(403);
  });
});

describe("validation (400)", () => {
  it("returns Arabic messages for the message and each field when Accept-Language is ar", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .set("Accept-Language", "ar")
      .send({ name: "", email: "not-an-email", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR", message: "فشل التحقق" });
    expect(res.body.details).toEqual(
      expect.arrayContaining([
        { path: "name", message: "الاسم مطلوب" },
        { path: "email", message: "أدخل بريدًا إلكترونيًا صالحًا" },
        { path: "password", message: "يجب ألا تقل كلمة المرور عن 8 أحرف" },
      ]),
    );
  });

  it("returns the same messages in English by default", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "A", email: "a@x.test", password: "short" });

    expect(res.body.message).toBe("Validation failed");
    expect(res.body.details).toEqual([
      { path: "password", message: "Password must be at least 8 characters" },
    ]);
  });

  it("rejects unknown fields and a missing body, still in the request's language", async () => {
    const extra = await request(app)
      .post("/api/v1/auth/login")
      .set("Accept-Language", "ar")
      .send({ email: "a@x.test", password: "x", role: "ADMIN" });
    const empty = await request(app).post("/api/v1/auth/login").set("Accept-Language", "ar");

    expect(extra.status).toBe(400);
    expect(extra.body.details[0].message).toBe("قيمة غير صالحة");
    expect(empty.status).toBe(400);
    expect(empty.body.message).toBe("فشل التحقق");
  });

  it("never echoes the submitted password in the error", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "A", email: "a@x.test", password: "pw" });

    expect(JSON.stringify(res.body)).not.toContain('"pw"');
  });
});

describe("POST /auth/signup", () => {
  it("creates an inactive EMPLOYEE with no permissions and returns no tokens", async () => {
    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "  Sara  ", email: "  Sara@Example.TEST ", password: PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toMatchObject({
      name: "Sara",
      email: "sara@example.test",
      role: "EMPLOYEE",
      isActive: false,
    });
    expect(res.body.data.message).toBe(
      "Account created. An administrator must activate it before you can sign in.",
    );
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|accessToken|\$2b\$/);
    expect(cookieHeader(res)).toBeUndefined();

    const stored = store.users[0];
    expect(stored?.passwordHash).not.toBe(PASSWORD);
    expect(bcrypt.getRounds(stored?.passwordHash ?? "")).toBe(12);
    expect(store.grants).toEqual([]);
  });

  it("writes an audit row without secrets", async () => {
    await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "Sara", email: "sara@example.test", password: PASSWORD });

    expect(store.auditRows).toHaveLength(1);
    expect(store.auditRows[0]).toMatchObject({
      action: "auth.signup",
      entity: "User",
      requestId: expect.any(String),
    });
    expect(JSON.stringify(store.auditRows)).not.toMatch(new RegExp(`${PASSWORD}|passwordHash|\\$2b\\$`));
  });

  it("answers 409 EMAIL_TAKEN for an existing email, in Arabic on request", async () => {
    seedEmployee();

    const res = await request(app)
      .post("/api/v1/auth/signup")
      .set("Accept-Language", "ar")
      .send({ name: "Other", email: "SARA@example.test", password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "EMAIL_TAKEN", message: "هذا البريد الإلكتروني مسجّل بالفعل" });
    expect(store.users).toHaveLength(1);
  });

  it("rolls the user back when the audit write fails", async () => {
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await request(app)
      .post("/api/v1/auth/signup")
      .send({ name: "Sara", email: "sara@example.test", password: PASSWORD });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("INTERNAL_ERROR");
    expect(store.users).toHaveLength(0);
  });
});

describe("POST /auth/login", () => {
  it("returns an access token in the body and the refresh token only in a hardened cookie", async () => {
    const user = seedEmployee();

    const res = await login();

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      expiresIn: 900,
      user: { id: user.id, email: "sara@example.test" },
    });
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    const refresh = refreshTokenOf(res);
    expect(JSON.stringify(res.body)).not.toContain(refresh);

    const cookie = cookieHeader(res) ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/Expires=/i);

    expect(store.refreshTokens).toHaveLength(1);
    expect(store.refreshTokens[0]?.tokenHash).toBe(sha256(refresh));
    expect(store.refreshTokens[0]?.tokenHash).not.toBe(refresh);
    expect(store.auditRows[0]).toMatchObject({ action: "auth.login", actorId: user.id });
  });

  it("omits Secure only in development", async () => {
    seedEmployee();
    env.NODE_ENV = "development";

    const res = await login();

    expect(cookieHeader(res)).not.toMatch(/Secure/i);
    expect(cookieHeader(res)).toMatch(/HttpOnly/i);
  });

  it("issues an access token that works on authenticated routes", async () => {
    seedEmployee();
    const res = await login();

    const me = await request(app)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${res.body.data.accessToken}`);

    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe("sara@example.test");
  });

  it("gives an identical response for an unknown email and a wrong password", async () => {
    seedEmployee();

    const unknown = await login("nobody@example.test", PASSWORD);
    const wrong = await login("sara@example.test", "Wrong-Password-1");

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect({ ...wrong.body, requestId: undefined }).toEqual({ ...unknown.body, requestId: undefined });
    expect(unknown.body).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Invalid email or password" });
    expect(cookieHeader(unknown)).toBeUndefined();
    expect(store.refreshTokens).toHaveLength(0);
  });

  it("translates the shared error", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Accept-Language", "ar")
      .send({ email: "nobody@example.test", password: PASSWORD });

    expect(res.body.message).toBe("البريد الإلكتروني أو كلمة المرور غير صحيحة");
  });

  it("answers ACCOUNT_INACTIVE only when the password was right", async () => {
    seedEmployee({ isActive: false });

    const right = await request(app)
      .post("/api/v1/auth/login")
      .set("Accept-Language", "ar")
      .send({ email: "sara@example.test", password: PASSWORD });
    const wrong = await login("sara@example.test", "Wrong-Password-1");

    expect(right.status).toBe(403);
    expect(right.body).toMatchObject({ code: "ACCOUNT_INACTIVE", message: "حسابك غير مفعّل بعد" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("INVALID_CREDENTIALS");
    expect(cookieHeader(right)).toBeUndefined();
    expect(store.refreshTokens).toHaveLength(0);
  });
});

describe("POST /auth/refresh", () => {
  it("rotates the token: new cookie, new access token, old token revoked", async () => {
    seedEmployee();
    const first = await login();
    const oldToken = refreshTokenOf(first);

    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${oldToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ expiresIn: 900, accessToken: expect.any(String) });
    expect(res.body.data).not.toHaveProperty("refreshToken");
    const newToken = refreshTokenOf(res);
    expect(newToken).not.toBe(oldToken);
    expect(cookieHeader(res)).toMatch(/HttpOnly/i);
    expect(cookieHeader(res)).toMatch(/SameSite=Strict/i);

    const byHash = (token: string) => store.refreshTokens.find((row) => row.tokenHash === sha256(token));
    expect(byHash(oldToken)?.revokedAt).toBeInstanceOf(Date);
    expect(byHash(newToken)?.revokedAt).toBeNull();

    const me = await request(app)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("keeps working across several rotations", async () => {
    seedEmployee();
    let token = refreshTokenOf(await login());

    for (let i = 0; i < 3; i++) {
      const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${token}`);
      expect(res.status).toBe(200);
      token = refreshTokenOf(res);
    }

    expect(store.refreshTokens.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  it("detects reuse of a token rotated long ago and revokes every refresh token of that user", async () => {
    const user = seedEmployee();
    const otherDevice = refreshTokenOf(await login());
    const stolen = refreshTokenOf(await login());
    const rotated = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${stolen}`);
    const legitimate = refreshTokenOf(rotated);
    rotatedAgo(stolen, 60_000);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const replay = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Accept-Language", "ar")
      .set("Cookie", `refresh_token=${stolen}`);

    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe("REFRESH_TOKEN_REUSED");
    expect(replay.body.message).toBe("لم تعد جلستك صالحة. يرجى تسجيل الدخول مرة أخرى");
    expect(
      store.refreshTokens.filter((row) => row.userId === user.id && row.revokedAt === null),
    ).toHaveLength(0);

    for (const token of [legitimate, otherDevice]) {
      const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${token}`);
      expect(res.status).toBe(401);
    }
  });

  it("does not touch another user's tokens when reuse is detected", async () => {
    seedEmployee();
    const other = store.addUser({ email: "omar@example.test", passwordHash });
    const otherToken = refreshTokenOf(await login("omar@example.test"));
    const mine = refreshTokenOf(await login());
    await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${mine}`);
    rotatedAgo(mine, 60_000);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${mine}`);

    expect(
      store.refreshTokens.filter((row) => row.userId === other.id && row.revokedAt === null),
    ).toHaveLength(1);
    const stillWorks = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", `refresh_token=${otherToken}`);
    expect(stillWorks.status).toBe(200);
  });

  it.each([
    ["no cookie", undefined],
    ["an unknown token", "refresh_token=made-up"],
  ])("rejects %s with INVALID_REFRESH_TOKEN and clears the cookie", async (_label, cookie) => {
    const req = request(app).post("/api/v1/auth/refresh");
    const res = await (cookie ? req.set("Cookie", cookie) : req);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_REFRESH_TOKEN");
    expect(cookieHeader(res)).toMatch(/refresh_token=;/);
  });

  it("rejects an expired token", async () => {
    seedEmployee();
    const token = refreshTokenOf(await login());
    store.refreshTokens[0]!.expiresAt = new Date(Date.now() - 1000);

    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${token}`);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("refuses a user deactivated after login and signs them out everywhere", async () => {
    const user = seedEmployee();
    const token = refreshTokenOf(await login());
    user.isActive = false;

    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_INACTIVE");
    expect(store.refreshTokens.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the current refresh token, clears the cookie and audits", async () => {
    const user = seedEmployee();
    const token = refreshTokenOf(await login());

    const res = await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${token}`);

    expect(res.status).toBe(204);
    expect(cookieHeader(res)).toMatch(/refresh_token=;.*Path=\/api\/v1\/auth/);
    expect(store.refreshTokens[0]?.revokedAt).toBeInstanceOf(Date);
    expect(store.auditRows.at(-1)).toMatchObject({ action: "auth.logout", actorId: user.id });
  });

  it("succeeds without a cookie and does not need an access token", async () => {
    const res = await request(app).post("/api/v1/auth/logout");

    expect(res.status).toBe(204);
    expect(store.auditRows).toHaveLength(0);
  });

  it("leaves other sessions alone", async () => {
    seedEmployee();
    const a = refreshTokenOf(await login());
    const b = refreshTokenOf(await login());

    await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${a}`);

    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${b}`);
    expect(res.status).toBe(200);
  });

  it("makes the logged-out token unusable", async () => {
    seedEmployee();
    const token = refreshTokenOf(await login());
    await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${token}`);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const res = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${token}`);

    expect(res.status).toBe(401);
  });
});

describe("password reset flow", () => {
  const mailbox = new RecordingMailer();
  beforeEach(() => {
    mailbox.reset();
    setMailer(mailbox);
  });
  afterEach(() => {
    setMailer(undefined);
  });

  // Asks for a reset and reads the token from the email that was sent. Earlier tokens are aged first, so the
  // one-a-minute cooldown does not get in the way of tests that ask more than once.
  async function requestResetLink(email: string): Promise<string> {
    for (const row of store.resetTokens) {
      row.createdAt = new Date(Date.now() - 120_000);
    }
    const before = mailbox.sent.length;
    await request(app).post("/api/v1/auth/forgot-password").send({ email });
    await vi.waitFor(() => expect(mailbox.sent.length).toBeGreaterThan(before));
    const message = mailbox.sent.at(-1);
    if (!message) {
      throw new Error("no reset email was sent");
    }
    return tokenIn(message);
  }

  it("answers identically whether or not the email exists", async () => {
    seedEmployee();

    const known = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "sara@example.test" });
    const unknown = await request(app)
      .post("/api/v1/auth/forgot-password")
      .send({ email: "nobody@example.test" });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual(known.body);
    expect(known.body.data.message).toBe("If the email is registered, a password reset link has been sent.");
    expect(store.resetTokens).toHaveLength(1);
    await vi.waitFor(() => expect(mailbox.sent).toHaveLength(1));
  });

  it("stores only a hash of the token, and the link is in the email and nowhere else", async () => {
    seedEmployee();
    const logs = (["info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation(() => undefined),
    );

    const token = await requestResetLink("sara@example.test");

    expect(store.resetTokens).toHaveLength(1);
    expect(store.resetTokens.map((row) => row.tokenHash)).toContain(sha256(token));
    expect(store.resetTokens.map((row) => row.tokenHash)).not.toContain(token);
    expect(JSON.stringify(logs.map((spy) => spy.mock.calls))).not.toContain(token);
  });

  it("resets the password, spends the token, revokes all sessions and signs the old password out", async () => {
    const user = seedEmployee();
    const session = refreshTokenOf(await login());
    const token = await requestResetLink("sara@example.test");

    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token, password: "Brand-New-Pass-1" });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("Your password has been reset. Please sign in.");
    expect((await login("sara@example.test", PASSWORD)).status).toBe(401);
    expect((await login("sara@example.test", "Brand-New-Pass-1")).status).toBe(200);

    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const old = await request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${session}`);
    expect(old.status).toBe(401);
    expect(store.resetTokens.every((row) => row.usedAt !== null)).toBe(true);
    expect(store.auditRows.find((row) => row.action === "auth.password_reset")).toMatchObject({
      actorId: user.id,
    });
    expect(JSON.stringify(store.auditRows)).not.toMatch(/Brand-New-Pass-1|\$2b\$/);
  });

  it("allows each token once only", async () => {
    seedEmployee();
    const token = await requestResetLink("sara@example.test");
    await request(app).post("/api/v1/auth/reset-password").send({ token, password: "Brand-New-Pass-1" });

    const again = await request(app)
      .post("/api/v1/auth/reset-password")
      .set("Accept-Language", "ar")
      .send({ token, password: "Another-Pass-22" });

    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({
      code: "INVALID_RESET_TOKEN",
      message: "رابط إعادة التعيين غير صالح أو منتهي",
    });
    expect((await login("sara@example.test", "Another-Pass-22")).status).toBe(401);
  });

  it("invalidates an older link when a new one is requested", async () => {
    seedEmployee();
    const first = await requestResetLink("sara@example.test");
    vi.restoreAllMocks();
    const second = await requestResetLink("sara@example.test");

    const old = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: first, password: "Brand-New-Pass-1" });
    const fresh = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: second, password: "Brand-New-Pass-1" });

    expect(old.status).toBe(400);
    expect(fresh.status).toBe(200);
  });

  it("rejects expired and unknown tokens with the same error", async () => {
    seedEmployee();
    const token = await requestResetLink("sara@example.test");
    store.resetTokens[0]!.expiresAt = new Date(Date.now() - 1000);

    const expired = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token, password: "Brand-New-Pass-1" });
    const unknown = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "nope", password: "Brand-New-Pass-1" });

    expect(expired.status).toBe(400);
    expect({ ...unknown.body, requestId: undefined }).toEqual({ ...expired.body, requestId: undefined });
  });

  it("rejects a weak new password without spending the token", async () => {
    seedEmployee();
    const token = await requestResetLink("sara@example.test");

    const weak = await request(app).post("/api/v1/auth/reset-password").send({ token, password: "short" });
    const ok = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token, password: "Brand-New-Pass-1" });

    expect(weak.status).toBe(400);
    expect(ok.status).toBe(200);
  });
});

describe("POST /auth/change-password", () => {
  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .send({ currentPassword: PASSWORD, newPassword: "Brand-New-Pass-1" });

    expect(res.status).toBe(401);
  });

  it("rejects a wrong current password", async () => {
    const user = seedEmployee();

    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set(await bearer(user))
      .set("Accept-Language", "ar")
      .send({ currentPassword: "Wrong-Password-1", newPassword: "Brand-New-Pass-1" });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: "INVALID_CURRENT_PASSWORD",
      message: "كلمة المرور الحالية غير صحيحة",
    });
    expect((await login("sara@example.test", PASSWORD)).status).toBe(200);
  });

  it("changes the password, keeps this session and revokes the others", async () => {
    const user = seedEmployee();
    const here = await login();
    const other = refreshTokenOf(await login());
    const hereToken = refreshTokenOf(here);

    const res = await request(app)
      .post("/api/v1/auth/change-password")
      .set("Authorization", `Bearer ${here.body.data.accessToken}`)
      .set("Cookie", `refresh_token=${hereToken}`)
      .send({ currentPassword: PASSWORD, newPassword: "Brand-New-Pass-1" });

    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("Your password has been changed.");
    expect(store.refreshTokens.find((row) => row.tokenHash === sha256(hereToken))?.revokedAt).toBeNull();
    expect(store.refreshTokens.find((row) => row.tokenHash === sha256(other))?.revokedAt).toBeInstanceOf(
      Date,
    );
    expect((await login("sara@example.test", PASSWORD)).status).toBe(401);
    expect((await login("sara@example.test", "Brand-New-Pass-1")).status).toBe(200);
    expect(store.auditRows.find((row) => row.action === "auth.password_changed")).toMatchObject({
      actorId: user.id,
    });
    expect(JSON.stringify(store.auditRows)).not.toMatch(/Brand-New-Pass-1|\$2b\$/);
  });

  it("revokes every session when the request carries no refresh cookie", async () => {
    const user = seedEmployee();
    await login();

    await request(app)
      .post("/api/v1/auth/change-password")
      .set(await bearer(user))
      .send({ currentPassword: PASSWORD, newPassword: "Brand-New-Pass-1" });

    expect(store.refreshTokens.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe("GET and PATCH /me", () => {
  it("returns the user and the granted permission codes", async () => {
    const user = seedEmployee();
    store.grant(user.id, PERMISSIONS.VILLAS_READ, PERMISSIONS.CONTRACTORS_READ);

    const res = await request(app)
      .get("/api/v1/me")
      .set(await bearer(user));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: user.id,
      name: "Sara",
      email: "sara@example.test",
      role: "EMPLOYEE",
      isActive: true,
      permissions: ["contractors:read", "villas:read"],
    });
    expect(res.body.data).not.toHaveProperty("passwordHash");
  });

  it("gives ADMIN every permission code", async () => {
    const admin = store.addUser({ email: "root@example.test", passwordHash, role: "ADMIN" });

    const res = await request(app)
      .get("/api/v1/me")
      .set(await bearer(admin));

    expect(res.body.data.permissions).toEqual([...PERMISSION_CODES]);
    expect(res.body.data.permissions).toHaveLength(80);
  });

  it("updates the name only, and audits the change", async () => {
    const user = seedEmployee();
    store.grant(user.id, PERMISSIONS.VILLAS_READ);

    const res = await request(app)
      .patch("/api/v1/me")
      .set(await bearer(user))
      .send({ name: "  Sara K  " });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      name: "Sara K",
      email: "sara@example.test",
      permissions: ["villas:read"],
    });
    expect(store.auditRows[0]).toMatchObject({
      action: "user.profile_updated",
      actorId: user.id,
      before: { name: "Sara" },
      after: { name: "Sara K" },
    });
  });

  it.each([
    ["email", { email: "new@example.test" }],
    ["role", { name: "Sara", role: "ADMIN" }],
    ["isActive", { name: "Sara", isActive: false }],
    ["an empty name", { name: "   " }],
    ["a too-long name", { name: "x".repeat(101) }],
  ])("rejects %s", async (_label, body) => {
    const user = seedEmployee();

    const res = await request(app)
      .patch("/api/v1/me")
      .set(await bearer(user))
      .send(body);

    expect(res.status).toBe(400);
    expect(store.users[0]).toMatchObject({
      role: "EMPLOYEE",
      isActive: true,
      email: "sara@example.test",
      name: "Sara",
    });
  });

  it("requires authentication for both verbs", async () => {
    expect((await request(app).get("/api/v1/me")).status).toBe(401);
    expect((await request(app).patch("/api/v1/me").send({ name: "X" })).status).toBe(401);
  });
});
