import { createHash, randomUUID } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { RecordingMailer, tokenIn } from "../auth/recording-mailer.js";
import { permissionTable } from "../permissions/in-memory-permissions.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/auth/repository/auth.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/auth/repository/auth.repository.js")>()),
  AuthRepository: (await import("../auth/in-memory-auth.repository.js")).InMemoryAuthRepository,
}));
vi.mock("../../../src/modules/users/repository/users.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/users/repository/users.repository.js")>()),
  UsersRepository: (await import("./in-memory-users.repository.js")).InMemoryUsersRepository,
}));
vi.mock("../../../src/modules/permissions/repository/permissions.repository.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../src/modules/permissions/repository/permissions.repository.js")
  >()),
  PermissionsRepository: (await import("../permissions/in-memory-permissions.repository.js"))
    .InMemoryPermissionsRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { setMailer } from "../../../src/core/mail/index.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

const app = createApp();
const ANY_ID = randomUUID();
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const mailbox = new RecordingMailer();

let admin: User;
beforeEach(() => {
  store.reset();
  permissionTable.reset();
  mailbox.reset();
  setMailer(mailbox);
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});
afterEach(() => {
  setMailer(undefined);
  vi.restoreAllMocks();
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});
const employee = (email: string, name = "Some Employee", overrides: Partial<User> = {}): User =>
  store.addUser({ name, email, passwordHash: "x", ...overrides });
const employeeWith = (email: string, ...codes: string[]): User => {
  const user = employee(email);
  store.grant(user.id, ...codes);
  return user;
};
const reset = async (id: string, headers?: { Authorization: string }, language = "en") =>
  request(app)
    .post(`/api/v1/users/${id}/reset-password`)
    .set(headers ?? (await as(admin)))
    .set("Accept-Language", language)
    .send();
const openSession = (userId: string) =>
  store.refreshTokens.push({
    id: randomUUID(),
    userId,
    tokenHash: randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000),
    revokedAt: null,
    replacedById: null,
    createdAt: new Date(),
  });
const liveSessions = (userId: string) =>
  store.refreshTokens.filter((token) => token.userId === userId && token.revokedAt === null);

describe("POST /users/:id/reset-password", () => {
  it("emails the user a reset link, signs out every session they have and audits it, without any secret", async () => {
    const user = employee("sara@example.test", "Sara");
    const other = employee("omar@example.test");
    openSession(user.id);
    openSession(user.id);
    openSession(other.id);

    const res = await reset(user.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { message: "A password reset link was sent to the user and their sessions were signed out." },
    });
    expect(mailbox.sent).toHaveLength(1);
    expect(mailbox.sent[0]).toMatchObject({
      to: "sara@example.test",
      subject: "Reset your Elecico password",
    });
    expect(mailbox.sent[0]?.html).toContain("An administrator has started a password reset");
    expect(mailbox.sent[0]?.html).toContain("Sara");

    expect(liveSessions(user.id)).toHaveLength(0);
    expect(liveSessions(other.id)).toHaveLength(1);

    const token = tokenIn(mailbox.sent[0]!);
    const [stored] = store.resetTokens.filter((row) => row.userId === user.id);
    expect(stored?.tokenHash).toBe(sha256(token));
    expect(stored?.tokenHash).not.toBe(token);
    expect(stored?.usedAt).toBeNull();
    const lifetime = (stored?.expiresAt.getTime() ?? 0) - (stored?.createdAt.getTime() ?? 0);
    expect(lifetime).toBeGreaterThan(29 * 60_000);
    expect(lifetime).toBeLessThanOrEqual(30 * 60_000);

    expect(store.auditRows).toHaveLength(1);
    expect(store.auditRows[0]).toMatchObject({
      action: "user.password_reset_issued",
      entity: "User",
      entityId: user.id,
      actorId: admin.id,
      after: { sessionsRevoked: true },
    });
    const everything = JSON.stringify({ audit: store.auditRows, response: res.body });
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(sha256(token));
    expect(everything).not.toContain("http");
  });

  it("the link works: the user chooses a new password with it and can sign in with that password", async () => {
    const user = employee("sara@example.test", "Sara");
    await reset(user.id);
    const token = tokenIn(mailbox.sent[0]!);

    const done = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token, password: "Brand-New-Pass-1" });
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "sara@example.test", password: "Brand-New-Pass-1" });

    expect(done.status).toBe(200);
    expect(login.status).toBe(200);
  });

  it("writes the email in the language of the administrator's request", async () => {
    const user = employee("sara@example.test");

    const res = await reset(user.id, undefined, "ar");

    expect(res.body.data.message).toBe(
      "تم إرسال رابط إعادة تعيين كلمة المرور إلى المستخدم وتم تسجيل خروجه من جميع جلساته.",
    );
    expect(mailbox.sent[0]?.html).toContain('dir="rtl"');
    expect(mailbox.sent[0]?.subject).toBe("إعادة تعيين كلمة المرور في Elecico");
  });

  it("a second reset voids the first link, and the administrator is not held to the one-a-minute cooldown", async () => {
    const user = employee("sara@example.test");

    expect((await reset(user.id)).status).toBe(200);
    expect((await reset(user.id)).status).toBe(200);

    expect(mailbox.sent).toHaveLength(2);
    const [first, second] = mailbox.sent.map(tokenIn);
    const rows = store.resetTokens.filter((row) => row.userId === user.id);
    expect(rows.find((row) => row.tokenHash === sha256(first!))?.usedAt).not.toBeNull();
    expect(rows.find((row) => row.tokenHash === sha256(second!))?.usedAt).toBeNull();
    const oldLink = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: first, password: "Brand-New-Pass-1" });
    expect(oldLink.status).toBe(400);
  });

  it("works for a user who is not active yet", async () => {
    const user = employee("sara@example.test", "Sara", { isActive: false });

    expect((await reset(user.id)).status).toBe(200);
    expect(mailbox.sent).toHaveLength(1);
  });

  describe("who may do it", () => {
    it("needs a signed-in user with users:update", async () => {
      const user = employee("sara@example.test");
      const noPermission = employeeWith("clerk@example.test", "users:read");

      const anonymous = await request(app).post(`/api/v1/users/${user.id}/reset-password`).send();
      const forbidden = await reset(user.id, await as(noPermission));

      expect(anonymous.status).toBe(401);
      expect(forbidden.status).toBe(403);
      expect(mailbox.sent).toHaveLength(0);
      expect(store.resetTokens).toHaveLength(0);
    });

    it("an employee with users:update may do it for another employee", async () => {
      const manager = employeeWith("manager@example.test", "users:update");
      const user = employee("sara@example.test");

      const res = await reset(user.id, await as(manager));

      expect(res.status).toBe(200);
      expect(store.auditRows[0]).toMatchObject({ actorId: manager.id, entityId: user.id });
    });

    it("only the ADMIN may do it for the ADMIN account", async () => {
      const manager = employeeWith("manager@example.test", "users:update");
      openSession(admin.id);

      const refused = await reset(admin.id, await as(manager), "ar");

      expect(refused.status).toBe(403);
      expect(refused.body.code).toBe("ADMIN_ACCOUNT_PROTECTED");
      expect(mailbox.sent).toHaveLength(0);
      expect(store.resetTokens).toHaveLength(0);
      expect(liveSessions(admin.id)).toHaveLength(1);
      expect(store.auditRows).toHaveLength(0);

      const allowed = await reset(admin.id);
      expect(allowed.status).toBe(200);
      expect(mailbox.sent[0]?.to).toBe("root@example.test");
    });

    it("is 404 for an unknown user and 400 for a malformed id, and sends nothing", async () => {
      const unknown = await reset(ANY_ID);
      const malformed = await reset("not-a-uuid");

      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe("USER_NOT_FOUND");
      expect(malformed.status).toBe(400);
      expect(mailbox.sent).toHaveLength(0);
    });
  });

  describe("when the email cannot be sent", () => {
    it("says so (502), but the reset is in place: sessions are out and the audit row is written; trying again works", async () => {
      const user = employee("sara@example.test");
      openSession(user.id);
      mailbox.failWith = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
      vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const failed = await reset(user.id, undefined, "ar");

      expect(failed.status).toBe(502);
      expect(failed.body).toMatchObject({
        code: "EMAIL_DELIVERY_FAILED",
        message:
          "تعذر إرسال رسالة إعادة التعيين. تم تسجيل خروج المستخدم من جميع جلساته. يرجى المحاولة مرة أخرى.",
      });
      expect(liveSessions(user.id)).toHaveLength(0);
      expect(store.auditRows).toHaveLength(1);

      mailbox.failWith = null;
      const again = await reset(user.id);
      expect(again.status).toBe(200);
      expect(mailbox.sent).toHaveLength(1);
    });
  });

  it("changes nothing at all when the audit entry cannot be written", async () => {
    const user = employee("sara@example.test");
    openSession(user.id);
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await reset(user.id);

    expect(res.status).toBe(500);
    expect(store.resetTokens).toHaveLength(0);
    expect(liveSessions(user.id)).toHaveLength(1);
    expect(mailbox.sent).toHaveLength(0);
  });

  it("never writes the link or the token to a log", async () => {
    const user = employee("sara@example.test");
    const spies = (["info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation(() => undefined),
    );

    await reset(user.id);

    const token = tokenIn(mailbox.sent[0]!);
    expect(JSON.stringify(spies.map((spy) => spy.mock.calls))).not.toContain(token);
  });
});
