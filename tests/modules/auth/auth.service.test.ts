import bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../src/core/config/logger.js";
import { env } from "../../../src/core/config/env.js";
import { AppError } from "../../../src/core/errors/AppError.js";
import { verifyAccessToken } from "../../../src/core/security/jwt.js";
import type { Role, User } from "../../../src/generated/prisma/client.js";
import { RecordingMailer, tokenIn } from "./recording-mailer.js";
import { AuthService, REFRESH_GRACE_MS } from "../../../src/modules/auth/service/auth.service.js";
import type { AuthRepository, Db } from "../../../src/modules/auth/repository/auth.repository.js";
import type { RequestContext } from "../../../src/modules/auth/dto/auth.dto.js";
import { PERMISSION_CODES } from "../../../src/shared/constants/permissions.js";

vi.mock("../../../src/core/audit/audit.js", () => ({ audit: { record: vi.fn() } }));
import { audit } from "../../../src/core/audit/audit.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const PASSWORD = "Correct-Horse-9";
const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const ctxAr: RequestContext = { ...ctx, locale: "ar" };
const tx = { marker: "tx" } as unknown as Db;
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function makeRepo() {
  return {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    findUserByEmail: vi.fn(),
    findUserById: vi.fn(),
    createUser: vi.fn(),
    updateUserName: vi.fn(),
    updateUserPassword: vi.fn(),
    getPermissionCodes: vi.fn(),
    createRefreshToken: vi.fn(),
    findRefreshTokenByHash: vi.fn(),
    revokeRefreshToken: vi.fn(),
    rotateRefreshToken: vi.fn(),
    revokeUserRefreshTokens: vi.fn(),
    latestOpenResetTokenAt: vi.fn(),
    createResetToken: vi.fn(),
    findResetTokenByHash: vi.fn(),
    useResetToken: vi.fn(),
    useAllResetTokens: vi.fn(),
  };
}
type Repo = ReturnType<typeof makeRepo>;

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 12);
});

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    name: "Sara",
    email: "sara@example.test",
    passwordHash,
    role: "EMPLOYEE",
    isActive: true,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function refreshRecord(
  overrides: {
    revokedAt?: Date | null;
    replacedById?: string | null;
    expiresAt?: Date;
    isActive?: boolean;
    role?: Role;
  } = {},
) {
  return {
    id: "rt-1",
    userId: "user-1",
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 3_600_000),
    revokedAt: overrides.revokedAt ?? null,
    replacedById: overrides.replacedById ?? null,
    user: {
      id: "user-1",
      role: overrides.role ?? ("EMPLOYEE" as const),
      isActive: overrides.isActive ?? true,
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

let repo: Repo;
let service: AuthService;
const auditCalls = () => vi.mocked(audit.record).mock.calls;

beforeEach(() => {
  vi.mocked(audit.record).mockReset();
  repo = makeRepo();
  service = new AuthService(repo as unknown as AuthRepository, () => NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("signup", () => {
  it("creates an inactive EMPLOYEE with a cost-12 hash, inside a transaction with its audit row", async () => {
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createUser.mockImplementation(async (data: { name: string; email: string; passwordHash: string }) =>
      makeUser({ ...data, id: "new-user", role: "EMPLOYEE", isActive: false }),
    );

    const dto = await service.signup({ name: "Sara", email: "sara@example.test", password: PASSWORD }, ctx);

    const [data, usedTx] = repo.createUser.mock.calls[0] as [{ passwordHash: string }, Db];
    expect(usedTx).toBe(tx);
    expect(data.passwordHash).not.toBe(PASSWORD);
    expect(bcrypt.getRounds(data.passwordHash)).toBe(12);
    await expect(bcrypt.compare(PASSWORD, data.passwordHash)).resolves.toBe(true);
    expect(dto).toMatchObject({ id: "new-user", role: "EMPLOYEE", isActive: false });
    expect(dto).not.toHaveProperty("passwordHash");

    expect(auditCalls()).toHaveLength(1);
    const [auditTx, entry] = auditCalls()[0] ?? [];
    expect(auditTx).toBe(tx);
    expect(entry).toMatchObject({
      action: "auth.signup",
      entity: "User",
      actorId: "new-user",
      entityId: "new-user",
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
  });

  it("rejects a taken email with 409 EMAIL_TAKEN before doing any work", async () => {
    repo.findUserByEmail.mockResolvedValue(makeUser());

    const err = await failure(
      service.signup({ name: "Sara", email: "sara@example.test", password: PASSWORD }, ctx),
    );

    expect(err).toMatchObject({ statusCode: 409, code: "EMAIL_TAKEN" });
    expect(repo.createUser).not.toHaveBeenCalled();
  });

  it("turns a unique-index race into the same 409", async () => {
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createUser.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));

    const err = await failure(
      service.signup({ name: "Sara", email: "sara@example.test", password: PASSWORD }, ctx),
    );

    expect(err).toMatchObject({ statusCode: 409, code: "EMAIL_TAKEN" });
  });

  it("fails as a whole when the audit write fails, so the transaction can roll back", async () => {
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createUser.mockResolvedValue(makeUser({ isActive: false }));
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(
      service.signup({ name: "Sara", email: "sara@example.test", password: PASSWORD }, ctx),
    ).rejects.toThrow("audit down");
  });

  it("translates the error message", async () => {
    repo.findUserByEmail.mockResolvedValue(makeUser());

    const err = await failure(
      service.signup({ name: "S", email: "sara@example.test", password: PASSWORD }, ctxAr),
    );

    expect(err.message).toBe("هذا البريد الإلكتروني مسجّل بالفعل");
  });
});

describe("login", () => {
  it("returns a 15-minute access token, a hashed refresh token and writes an audit row", async () => {
    repo.findUserByEmail.mockResolvedValue(makeUser());

    const { body, refresh } = await service.login({ email: "sara@example.test", password: PASSWORD }, ctx);

    expect(body.expiresIn).toBe(900);
    await expect(verifyAccessToken(body.accessToken)).resolves.toEqual({ userId: "user-1" });
    expect(body.user).toMatchObject({ id: "user-1", email: "sara@example.test" });
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(body)).not.toContain(refresh.token);

    const [stored, usedTx] = repo.createRefreshToken.mock.calls[0] as [
      { userId: string; tokenHash: string; expiresAt: Date },
      Db,
    ];
    expect(usedTx).toBe(tx);
    expect(stored.tokenHash).toBe(sha256(refresh.token));
    expect(stored.tokenHash).not.toBe(refresh.token);
    expect(stored.expiresAt).toEqual(new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000));
    expect(refresh.expiresAt).toEqual(stored.expiresAt);
    expect(auditCalls()[0]?.[1]).toMatchObject({ action: "auth.login", actorId: "user-1" });
  });

  it("gives the same error for an unknown email and a wrong password, and still hashes for the unknown one", async () => {
    const compare = vi.spyOn(bcrypt, "compare");

    repo.findUserByEmail.mockResolvedValueOnce(null);
    const unknown = await failure(service.login({ email: "nobody@example.test", password: PASSWORD }, ctx));
    expect(compare).toHaveBeenCalledTimes(1);

    repo.findUserByEmail.mockResolvedValueOnce(makeUser());
    const wrong = await failure(
      service.login({ email: "sara@example.test", password: "wrong-password" }, ctx),
    );

    expect(unknown).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
    expect({ s: wrong.statusCode, c: wrong.code, m: wrong.message }).toEqual({
      s: unknown.statusCode,
      c: unknown.code,
      m: unknown.message,
    });
    expect(repo.createRefreshToken).not.toHaveBeenCalled();
  });

  it("translates the shared error message", async () => {
    repo.findUserByEmail.mockResolvedValue(null);

    const err = await failure(service.login({ email: "nobody@example.test", password: PASSWORD }, ctxAr));

    expect(err.message).toBe("البريد الإلكتروني أو كلمة المرور غير صحيحة");
  });

  it("reports ACCOUNT_INACTIVE only after the password is verified", async () => {
    repo.findUserByEmail.mockResolvedValue(makeUser({ isActive: false }));

    const right = await failure(service.login({ email: "sara@example.test", password: PASSWORD }, ctx));
    const wrong = await failure(
      service.login({ email: "sara@example.test", password: "wrong-password" }, ctx),
    );

    expect(right).toMatchObject({ statusCode: 403, code: "ACCOUNT_INACTIVE" });
    expect(wrong).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
    expect(repo.createRefreshToken).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);
  });
});

describe("refresh", () => {
  it("rejects a missing or unknown token", async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(null);

    expect(await failure(service.refresh(undefined, ctx))).toMatchObject({
      statusCode: 401,
      code: "INVALID_REFRESH_TOKEN",
    });
    expect(await failure(service.refresh("unknown", ctx))).toMatchObject({
      statusCode: 401,
      code: "INVALID_REFRESH_TOKEN",
    });
    expect(repo.findRefreshTokenByHash).toHaveBeenCalledWith(sha256("unknown"));
  });

  it("rotates: spends the presented token and stores a different new hash, in one transaction", async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(refreshRecord());
    repo.rotateRefreshToken.mockResolvedValue(true);

    const { body, refresh } = await service.refresh("old-token", ctx);

    expect(repo.transaction).toHaveBeenCalledTimes(1);
    const [id, at, created, usedTx] = repo.rotateRefreshToken.mock.calls[0] as [
      string,
      Date,
      { tokenHash: string; userId: string; expiresAt: Date },
      Db,
    ];
    expect(id).toBe("rt-1");
    expect(at).toEqual(NOW);
    expect(usedTx).toBe(tx);
    expect(created.tokenHash).toBe(sha256(refresh.token));
    expect(refresh.token).not.toBe("old-token");
    expect(created.userId).toBe("user-1");
    expect(created.expiresAt).toEqual(refresh.expiresAt);
    await expect(verifyAccessToken(body.accessToken)).resolves.toEqual({ userId: "user-1" });
    expect(repo.revokeUserRefreshTokens).not.toHaveBeenCalled();
  });

  describe("a token presented again after it was rotated", () => {
    const rotatedAgo = (ms: number) =>
      refreshRecord({ revokedAt: new Date(NOW.getTime() - ms), replacedById: "rt-2" });

    it.each([0, 1, 5_000, REFRESH_GRACE_MS - 1])(
      "%i ms later is a retryable 409: nothing is revoked, issued or cleared",
      async (ms) => {
        repo.findRefreshTokenByHash.mockResolvedValue(rotatedAgo(ms));

        const err = await failure(service.refresh("rotated-token", ctx));

        expect(err).toMatchObject({ statusCode: 409, code: "REFRESH_CONFLICT" });
        expect(repo.revokeUserRefreshTokens).not.toHaveBeenCalled();
        expect(repo.rotateRefreshToken).not.toHaveBeenCalled();
        expect(repo.createRefreshToken).not.toHaveBeenCalled();
        expect(repo.transaction).not.toHaveBeenCalled();
      },
    );

    it.each([REFRESH_GRACE_MS, REFRESH_GRACE_MS + 1, 60_000, 3_600_000])(
      "%i ms later is reuse: every refresh token of the user is revoked",
      async (ms) => {
        repo.findRefreshTokenByHash.mockResolvedValue(rotatedAgo(ms));
        const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

        const err = await failure(service.refresh("stolen-token", ctx));

        expect(err).toMatchObject({ statusCode: 401, code: "REFRESH_TOKEN_REUSED" });
        expect(repo.revokeUserRefreshTokens).toHaveBeenCalledWith("user-1", NOW);
        expect(repo.rotateRefreshToken).not.toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain("stolen-token");
      },
    );

    it("the grace window is 20 seconds", () => {
      expect(REFRESH_GRACE_MS).toBe(20_000);
    });
  });

  it("a token revoked any other way (logout, password change) is reuse at once, however recent", async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(
      refreshRecord({ revokedAt: new Date(NOW.getTime() - 1000), replacedById: null }),
    );
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const err = await failure(service.refresh("logged-out-token", ctx));

    expect(err).toMatchObject({ statusCode: 401, code: "REFRESH_TOKEN_REUSED" });
    expect(repo.revokeUserRefreshTokens).toHaveBeenCalledWith("user-1", NOW);
  });

  it("losing a concurrent rotation is a retryable 409 with a warning: the family is not revoked", async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(refreshRecord());
    repo.rotateRefreshToken.mockResolvedValue(false);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const err = await failure(service.refresh("raced-token", ctx));

    expect(err).toMatchObject({ statusCode: 409, code: "REFRESH_CONFLICT" });
    expect(repo.revokeUserRefreshTokens).not.toHaveBeenCalled();
    expect(repo.createRefreshToken).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({ userId: "user-1" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("raced-token");
  });

  it("answers the conflict in the language of the request", async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(refreshRecord({ revokedAt: NOW, replacedById: "rt-2" }));

    const en = await failure(service.refresh("t", ctx));
    const ar = await failure(service.refresh("t", ctxAr));

    expect(en.message).toBe("Your session was just refreshed by another request. Please try again");
    expect(ar.message).not.toBe(en.message);
    expect(ar.message).toMatch(/[؀-ۿ]/);
  });

  it("rejects an expired token without touching other tokens", async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(refreshRecord({ expiresAt: new Date(NOW.getTime() - 1) }));

    expect(await failure(service.refresh("expired", ctx))).toMatchObject({ code: "INVALID_REFRESH_TOKEN" });
    expect(repo.revokeUserRefreshTokens).not.toHaveBeenCalled();
  });

  it("refuses an inactive user and signs them out everywhere", async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(refreshRecord({ isActive: false }));

    const err = await failure(service.refresh("token", ctx));

    expect(err).toMatchObject({ statusCode: 403, code: "ACCOUNT_INACTIVE" });
    expect(repo.revokeUserRefreshTokens).toHaveBeenCalledWith("user-1", NOW);
    expect(repo.createRefreshToken).not.toHaveBeenCalled();
  });
});

describe("logout", () => {
  it("does nothing without a token, with an unknown token, or with one already revoked", async () => {
    repo.findRefreshTokenByHash.mockResolvedValueOnce(null);
    await service.logout(undefined, ctx);
    await service.logout("unknown", ctx);
    repo.findRefreshTokenByHash.mockResolvedValueOnce(refreshRecord({ revokedAt: NOW }));
    await service.logout("revoked", ctx);

    expect(repo.revokeRefreshToken).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);
  });

  it("revokes the current token and audits it in the same transaction", async () => {
    repo.findRefreshTokenByHash.mockResolvedValue(refreshRecord());
    repo.revokeRefreshToken.mockResolvedValue(true);

    await service.logout("current", ctx);

    expect(repo.revokeRefreshToken).toHaveBeenCalledWith("rt-1", NOW, tx);
    expect(auditCalls()[0]?.[0]).toBe(tx);
    expect(auditCalls()[0]?.[1]).toMatchObject({ action: "auth.logout", actorId: "user-1" });
  });
});

describe("forgotPassword", () => {
  let mailbox: RecordingMailer;
  let withMailer: AuthService;
  beforeEach(() => {
    mailbox = new RecordingMailer();
    withMailer = new AuthService(repo as unknown as AuthRepository, () => NOW, mailbox);
    repo.latestOpenResetTokenAt.mockResolvedValue(null);
  });

  it("resolves without creating or sending anything for an unknown email", async () => {
    repo.findUserByEmail.mockResolvedValue(null);

    await expect(withMailer.forgotPassword({ email: "nobody@example.test" }, ctx)).resolves.toBeUndefined();

    expect(repo.createResetToken).not.toHaveBeenCalled();
    expect(mailbox.sent).toHaveLength(0);
  });

  it("stores only the hash, valid for 30 minutes, after spending earlier tokens, and emails the raw token", async () => {
    repo.findUserByEmail.mockResolvedValue(makeUser({ name: "Sara" }));

    await withMailer.forgotPassword({ email: "sara@example.test" }, ctx);

    expect(repo.useAllResetTokens).toHaveBeenCalledWith("user-1", NOW, tx);
    const [stored, usedTx] = repo.createResetToken.mock.calls[0] as [
      { tokenHash: string; expiresAt: Date; userId: string },
      Db,
    ];
    expect(usedTx).toBe(tx);
    expect(stored.expiresAt).toEqual(new Date(NOW.getTime() + 30 * 60 * 1000));
    expect(repo.transaction).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(mailbox.sent).toHaveLength(1));
    const [message] = mailbox.sent;
    expect(message?.to).toBe("sara@example.test");
    const token = tokenIn(message!);
    expect(message?.html).toContain(env.PASSWORD_RESET_URL);
    expect(sha256(token)).toBe(stored.tokenHash);
    expect(token).not.toBe(stored.tokenHash);
  });

  it.each([
    ["en", ctx, /Reset your Elecico password/],
    ["ar", ctxAr, /إعادة تعيين كلمة المرور/],
  ])("writes the email in the language of the request (%s)", async (_label, context, subject) => {
    repo.findUserByEmail.mockResolvedValue(makeUser());

    await withMailer.forgotPassword({ email: "sara@example.test" }, context);

    await vi.waitFor(() => expect(mailbox.sent).toHaveLength(1));
    expect(mailbox.sent[0]?.subject).toMatch(subject);
    expect(mailbox.sent[0]?.html).toContain(context.locale === "ar" ? 'dir="rtl"' : 'dir="ltr"');
  });

  describe("the one-a-minute cooldown for each user", () => {
    it.each([0, 1, 30_000, 59_999])(
      "a link issued %i ms ago: nothing new is created or sent, and the call still resolves",
      async (ago) => {
        repo.findUserByEmail.mockResolvedValue(makeUser());
        repo.latestOpenResetTokenAt.mockResolvedValue(new Date(NOW.getTime() - ago));

        await expect(withMailer.forgotPassword({ email: "sara@example.test" }, ctx)).resolves.toBeUndefined();

        expect(repo.useAllResetTokens).not.toHaveBeenCalled();
        expect(repo.createResetToken).not.toHaveBeenCalled();
        expect(repo.transaction).not.toHaveBeenCalled();
        await Promise.resolve();
        expect(mailbox.sent).toHaveLength(0);
      },
    );

    it.each([60_000, 61_000, 3_600_000])("a link issued %i ms ago: a new one goes out", async (ago) => {
      repo.findUserByEmail.mockResolvedValue(makeUser());
      repo.latestOpenResetTokenAt.mockResolvedValue(new Date(NOW.getTime() - ago));

      await withMailer.forgotPassword({ email: "sara@example.test" }, ctx);

      expect(repo.createResetToken).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(mailbox.sent).toHaveLength(1));
    });

    it("looks only at tokens that are still usable", async () => {
      repo.findUserByEmail.mockResolvedValue(makeUser());

      await withMailer.forgotPassword({ email: "sara@example.test" }, ctx);

      expect(repo.latestOpenResetTokenAt).toHaveBeenCalledWith("user-1", NOW);
    });
  });

  it("does not fail, and keeps the token, when the mail cannot be sent; only the server's reason is logged", async () => {
    repo.findUserByEmail.mockResolvedValue(makeUser());
    mailbox.failWith = Object.assign(
      new Error("Invalid login: 535-5.7.8 Username and Password not accepted"),
      {
        code: "EAUTH",
        responseCode: 535,
        command: "AUTH PLAIN",
      },
    );
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    await expect(withMailer.forgotPassword({ email: "sara@example.test" }, ctx)).resolves.toBeUndefined();

    expect(repo.createResetToken).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(error.mock.calls[0]?.[0]).toEqual({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" });
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).not.toContain("sara@example.test");
    expect(logged).not.toMatch(/https?:\/\//);
  });

  it("does not wait for the mail server", async () => {
    repo.findUserByEmail.mockResolvedValue(makeUser());
    const slow = { send: vi.fn(() => new Promise<void>(() => undefined)) };
    const impatient = new AuthService(repo as unknown as AuthRepository, () => NOW, slow);

    await expect(impatient.forgotPassword({ email: "sara@example.test" }, ctx)).resolves.toBeUndefined();

    await vi.waitFor(() => expect(slow.send).toHaveBeenCalledTimes(1));
  });

  it.each(["development", "production", "test"] as const)(
    "never writes the link or the token to a log, whatever the environment (%s)",
    async (nodeEnv) => {
      repo.findUserByEmail.mockResolvedValue(makeUser());
      env.NODE_ENV = nodeEnv;
      try {
        const spies = (["info", "warn", "error", "debug", "trace", "fatal"] as const).map((level) =>
          vi.spyOn(logger, level).mockImplementation(() => undefined),
        );

        await withMailer.forgotPassword({ email: "sara@example.test" }, ctx);
        await vi.waitFor(() => expect(mailbox.sent).toHaveLength(1));

        const token = tokenIn(mailbox.sent[0]!);
        const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
        expect(logged).not.toContain(token);
        expect(logged).not.toContain(env.PASSWORD_RESET_URL);
      } finally {
        env.NODE_ENV = "test";
      }
    },
  );
});

describe("resetPassword", () => {
  const resetRecord = (overrides: { usedAt?: Date | null; expiresAt?: Date } = {}) => ({
    id: "reset-1",
    userId: "user-1",
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 60_000),
    usedAt: overrides.usedAt ?? null,
  });

  it.each([
    ["unknown", null],
    ["used", resetRecord({ usedAt: NOW })],
    ["expired", resetRecord({ expiresAt: new Date(NOW.getTime() - 1) })],
  ])(
    "rejects a %s token with the same INVALID_RESET_TOKEN error and changes nothing",
    async (_label, record) => {
      repo.findResetTokenByHash.mockResolvedValue(record);

      const err = await failure(service.resetPassword({ token: "tok", password: "New-Password-1" }, ctx));

      expect(err).toMatchObject({ statusCode: 400, code: "INVALID_RESET_TOKEN" });
      expect(repo.updateUserPassword).not.toHaveBeenCalled();
      expect(repo.revokeUserRefreshTokens).not.toHaveBeenCalled();
    },
  );

  it("sets the new password, spends the token, revokes every refresh token and audits, all in one transaction", async () => {
    repo.findResetTokenByHash.mockResolvedValue(resetRecord());
    repo.useResetToken.mockResolvedValue(true);

    await service.resetPassword({ token: "tok", password: "New-Password-1" }, ctx);

    expect(repo.findResetTokenByHash).toHaveBeenCalledWith(sha256("tok"));
    expect(repo.useResetToken).toHaveBeenCalledWith("reset-1", NOW, tx);
    const [userId, hash, usedTx] = repo.updateUserPassword.mock.calls[0] as [string, string, Db];
    expect(userId).toBe("user-1");
    expect(usedTx).toBe(tx);
    expect(bcrypt.getRounds(hash)).toBe(12);
    await expect(bcrypt.compare("New-Password-1", hash)).resolves.toBe(true);
    expect(repo.revokeUserRefreshTokens).toHaveBeenCalledWith("user-1", NOW, {}, tx);
    expect(auditCalls()[0]?.[1]).toMatchObject({ action: "auth.password_reset", actorId: "user-1" });
    expect(repo.transaction).toHaveBeenCalledTimes(1);
  });

  it("is single use even under a race: losing the token update changes nothing", async () => {
    repo.findResetTokenByHash.mockResolvedValue(resetRecord());
    repo.useResetToken.mockResolvedValue(false);

    const err = await failure(service.resetPassword({ token: "tok", password: "New-Password-1" }, ctx));

    expect(err).toMatchObject({ code: "INVALID_RESET_TOKEN" });
    expect(repo.updateUserPassword).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);
  });
});

describe("changePassword", () => {
  it("rejects a wrong current password without changing anything", async () => {
    repo.findUserById.mockResolvedValue(makeUser());

    const err = await failure(
      service.changePassword(
        "user-1",
        undefined,
        { currentPassword: "nope", newPassword: "New-Password-1" },
        ctx,
      ),
    );

    expect(err).toMatchObject({ statusCode: 400, code: "INVALID_CURRENT_PASSWORD" });
    expect(repo.updateUserPassword).not.toHaveBeenCalled();
    expect(repo.revokeUserRefreshTokens).not.toHaveBeenCalled();
  });

  it("keeps the caller's own session and revokes the others", async () => {
    repo.findUserById.mockResolvedValue(makeUser());
    repo.findRefreshTokenByHash.mockResolvedValue(refreshRecord());

    await service.changePassword(
      "user-1",
      "my-cookie",
      { currentPassword: PASSWORD, newPassword: "New-Password-1" },
      ctx,
    );

    expect(repo.findRefreshTokenByHash).toHaveBeenCalledWith(sha256("my-cookie"));
    expect(repo.revokeUserRefreshTokens).toHaveBeenCalledWith("user-1", NOW, { exceptId: "rt-1" }, tx);
    const [, hash] = repo.updateUserPassword.mock.calls[0] as [string, string];
    expect(bcrypt.getRounds(hash)).toBe(12);
    expect(auditCalls()[0]?.[1]).toMatchObject({ action: "auth.password_changed", actorId: "user-1" });
  });

  it("revokes every session when there is no cookie, or the cookie belongs to someone else", async () => {
    repo.findUserById.mockResolvedValue(makeUser());

    await service.changePassword(
      "user-1",
      undefined,
      { currentPassword: PASSWORD, newPassword: "New-Password-1" },
      ctx,
    );
    repo.findRefreshTokenByHash.mockResolvedValue({ ...refreshRecord(), userId: "someone-else" });
    await service.changePassword(
      "user-1",
      "foreign",
      { currentPassword: PASSWORD, newPassword: "New-Password-1" },
      ctx,
    );

    expect(repo.revokeUserRefreshTokens).toHaveBeenNthCalledWith(
      1,
      "user-1",
      NOW,
      { exceptId: undefined },
      tx,
    );
    expect(repo.revokeUserRefreshTokens).toHaveBeenNthCalledWith(
      2,
      "user-1",
      NOW,
      { exceptId: undefined },
      tx,
    );
  });
});

describe("getMe and updateMe", () => {
  it("gives ADMIN every permission code without reading the database", async () => {
    repo.findUserById.mockResolvedValue(makeUser({ role: "ADMIN" }));

    const me = await service.getMe("user-1", ctx);

    expect(me.permissions).toEqual([...PERMISSION_CODES]);
    expect(me.permissions).toHaveLength(80);
    expect(repo.getPermissionCodes).not.toHaveBeenCalled();
    expect(me).not.toHaveProperty("passwordHash");
  });

  it("gives an EMPLOYEE only the codes granted in the database", async () => {
    repo.findUserById.mockResolvedValue(makeUser());
    repo.getPermissionCodes.mockResolvedValue(["villas:read"]);

    await expect(service.getMe("user-1", ctx)).resolves.toMatchObject({ permissions: ["villas:read"] });
  });

  it("answers 401 when the user no longer exists", async () => {
    repo.findUserById.mockResolvedValue(null);

    expect(await failure(service.getMe("ghost", ctx))).toMatchObject({ statusCode: 401 });
  });

  it("updates the name only and audits the before and after values", async () => {
    repo.findUserById.mockResolvedValue(makeUser());
    repo.updateUserName.mockResolvedValue(makeUser({ name: "Sara K" }));
    repo.getPermissionCodes.mockResolvedValue(["villas:read"]);

    const dto = await service.updateMe("user-1", { name: "Sara K" }, ctx);

    expect(repo.updateUserName).toHaveBeenCalledWith("user-1", "Sara K", tx);
    expect(dto.name).toBe("Sara K");
    expect(dto.permissions).toEqual(["villas:read"]);
    expect(auditCalls()[0]?.[1]).toMatchObject({
      action: "user.profile_updated",
      before: { name: "Sara" },
      after: { name: "Sara K" },
    });
  });
});

describe("audit entries", () => {
  it("never contain a password, a password hash or a token", async () => {
    repo.findUserByEmail.mockResolvedValue(null);
    repo.createUser.mockResolvedValue(makeUser({ isActive: false }));
    await service.signup({ name: "Sara", email: "sara@example.test", password: PASSWORD }, ctx);

    repo.findUserByEmail.mockResolvedValue(makeUser());
    const { refresh } = await service.login({ email: "sara@example.test", password: PASSWORD }, ctx);

    repo.findUserById.mockResolvedValue(makeUser());
    await service.changePassword(
      "user-1",
      refresh.token,
      { currentPassword: PASSWORD, newPassword: "New-Password-1" },
      ctx,
    );

    const serialised = JSON.stringify(auditCalls().map(([, entry]) => entry));
    expect(auditCalls().length).toBeGreaterThanOrEqual(3);
    for (const secret of [PASSWORD, "New-Password-1", passwordHash, refresh.token, sha256(refresh.token)]) {
      expect(serialised).not.toContain(secret);
    }
  });
});
