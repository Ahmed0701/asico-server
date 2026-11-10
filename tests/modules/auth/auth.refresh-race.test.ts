import bcrypt from "bcrypt";
import { createHash } from "node:crypto";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryAuthRepository, store } from "./in-memory-auth.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("./in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/auth/repository/auth.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/auth/repository/auth.repository.js")>()),
  AuthRepository: (await import("./in-memory-auth.repository.js")).InMemoryAuthRepository,
}));

import { createApp } from "../../../src/app.js";
import { logger } from "../../../src/core/config/logger.js";
import { REFRESH_GRACE_MS } from "../../../src/modules/auth/service/auth.service.js";

const PASSWORD = "Correct-Horse-9";
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const app = createApp();

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(() => {
  store.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const seedEmployee = () => store.addUser({ email: "sara@example.test", name: "Sara", passwordHash });

const refreshCookies = (res: request.Response): string[] =>
  ((res.headers["set-cookie"] as unknown as string[] | undefined) ?? []).filter((cookie) =>
    cookie.startsWith("refresh_token="),
  );

function newCookieOf(res: request.Response): string {
  const [header] = refreshCookies(res);
  if (!header) {
    throw new Error("no refresh_token cookie was set");
  }
  return decodeURIComponent((header.split(";")[0] ?? "").slice("refresh_token=".length));
}

const isClearing = (res: request.Response): boolean =>
  refreshCookies(res).some((cookie) => /^refresh_token=;/.test(cookie));

const login = () =>
  request(app).post("/api/v1/auth/login").send({ email: "sara@example.test", password: PASSWORD });
const refresh = (token: string) =>
  request(app).post("/api/v1/auth/refresh").set("Cookie", `refresh_token=${token}`);
const rowOf = (token: string) => store.refreshTokens.find((row) => row.tokenHash === sha256(token));
const liveRows = () => store.refreshTokens.filter((row) => row.revokedAt === null);

// Both requests read the token before either one rotates it: the interleaving of two tabs, or of a double fetch,
// when it is as unlucky as it gets.
function bothReadBeforeEitherWrites(token: string) {
  const original = InMemoryAuthRepository.prototype.findRefreshTokenByHash;
  let waiting: (() => void)[] = [];
  return vi
    .spyOn(InMemoryAuthRepository.prototype, "findRefreshTokenByHash")
    .mockImplementation(async function (this: InMemoryAuthRepository, hash: string) {
      const record = await original.call(this, hash);
      if (hash === sha256(token)) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          if (waiting.length === 2) {
            const all = waiting;
            waiting = [];
            for (const release of all) release();
          }
        });
      }
      return record;
    });
}

describe("two refreshes with the same cookie at the same time", () => {
  it("one wins and keeps a valid session; the other gets a retryable 409 and revokes nothing", async () => {
    const user = seedEmployee();
    const cookie = newCookieOf(await login());
    bothReadBeforeEitherWrites(cookie);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)]);

    const winner = [a, b].find((res) => res.status === 200)!;
    const loser = [a, b].find((res) => res.status === 409)!;
    expect(winner).toBeDefined();
    expect(loser).toBeDefined();
    expect(loser.body).toMatchObject({ code: "REFRESH_CONFLICT", message: expect.any(String) });
    expect(loser.body.requestId).toEqual(expect.any(String));

    // The loser sends no Set-Cookie at all: neither a clearing one nor a new one. The winner's stays in the browser.
    expect(refreshCookies(loser)).toHaveLength(0);
    expect(refreshCookies(winner)).toHaveLength(1);
    expect(isClearing(winner)).toBe(false);

    // Nothing was revoked beyond the one token that was spent, which points at the token that replaced it.
    const winnersToken = newCookieOf(winner);
    expect(liveRows().map((row) => row.tokenHash)).toEqual([sha256(winnersToken)]);
    expect(rowOf(cookie)?.revokedAt).toBeInstanceOf(Date);
    expect(rowOf(cookie)?.replacedById).toBe(rowOf(winnersToken)?.id);
    expect(store.refreshTokens.filter((row) => row.userId === user.id)).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/lost a race/);

    // The session carries on: the winner's access token works and so does its cookie.
    const me = await request(app)
      .get("/api/v1/me")
      .set("Authorization", `Bearer ${winner.body.data.accessToken}`);
    expect(me.status).toBe(200);
    const next = await refresh(winnersToken);
    expect(next.status).toBe(200);
  });

  it("the loser retries with the cookie the winner set and gets a session too", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    bothReadBeforeEitherWrites(cookie);

    const [a, b] = await Promise.all([refresh(cookie), refresh(cookie)]);
    vi.restoreAllMocks();
    const winner = [a, b].find((res) => res.status === 200)!;
    const retry = await refresh(newCookieOf(winner));

    expect(retry.status).toBe(200);
    expect(retry.body.data.accessToken).toEqual(expect.any(String));
    expect(liveRows()).toHaveLength(1);
  });

  it("runs of several at once leave exactly one winner and a session that still works", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());

    const results = await Promise.all(Array.from({ length: 6 }, () => refresh(cookie)));

    const statuses = results.map((res) => res.status).sort();
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(5);
    expect(results.filter(isClearing)).toHaveLength(0);
    const winner = results.find((res) => res.status === 200)!;
    expect(liveRows().map((row) => row.tokenHash)).toEqual([sha256(newCookieOf(winner))]);
    expect((await refresh(newCookieOf(winner))).status).toBe(200);
  });

  it("a request that arrives just after the winner finished gets the same 409, and the winner's session survives", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    const winner = await refresh(cookie);
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    const late = await refresh(cookie);

    expect(late.status).toBe(409);
    expect(late.body.code).toBe("REFRESH_CONFLICT");
    expect(refreshCookies(late)).toHaveLength(0);
    expect(info).toHaveBeenCalledWith(expect.any(Object), expect.stringMatching(/just after its rotation/));
    expect(liveRows().map((row) => row.tokenHash)).toEqual([sha256(newCookieOf(winner))]);
    expect((await refresh(newCookieOf(winner))).status).toBe(200);
  });
});

describe("the grace window", () => {
  const rotateAt = async (): Promise<{ cookie: string; at: number }> => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    vi.useFakeTimers({ toFake: ["Date"], now: new Date() });
    const at = Date.now();
    expect((await refresh(cookie)).status).toBe(200);
    return { cookie, at };
  };

  it.each([0, 1, 10_000, REFRESH_GRACE_MS - 1])(
    "%i ms after the rotation: 409, nothing revoked",
    async (after) => {
      const { cookie, at } = await rotateAt();
      vi.setSystemTime(at + after);

      const res = await refresh(cookie);

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("REFRESH_CONFLICT");
      expect(refreshCookies(res)).toHaveLength(0);
      expect(liveRows()).toHaveLength(1);
    },
  );

  it.each([REFRESH_GRACE_MS, REFRESH_GRACE_MS + 1, 120_000])(
    "%i ms after the rotation: reuse, every token revoked and the cookie cleared",
    async (after) => {
      const { cookie, at } = await rotateAt();
      vi.setSystemTime(at + after);
      vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      const res = await refresh(cookie);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("REFRESH_TOKEN_REUSED");
      expect(isClearing(res)).toBe(true);
      expect(liveRows()).toHaveLength(0);
    },
  );

  it("is judged from the moment of the rotation, not from the login", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(Date.now() + 3_600_000) });
    const at = Date.now();
    await refresh(cookie);
    vi.setSystemTime(at + 5_000);

    expect((await refresh(cookie)).status).toBe(409);
  });

  it("a token that was logged out is reuse at once, not a conflict", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    await request(app).post("/api/v1/auth/logout").set("Cookie", `refresh_token=${cookie}`);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const res = await refresh(cookie);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("REFRESH_TOKEN_REUSED");
    expect(isClearing(res)).toBe(true);
  });
});

describe("which answers clear the refresh cookie", () => {
  it.each([
    ["no cookie", () => request(app).post("/api/v1/auth/refresh"), "INVALID_REFRESH_TOKEN"],
    ["an unknown cookie", () => refresh("made-up"), "INVALID_REFRESH_TOKEN"],
  ])("%s: %s clears it", async (_label, call, code) => {
    const res = await call();

    expect(res.body.code).toBe(code);
    expect(isClearing(res)).toBe(true);
  });

  it("an inactive account clears it", async () => {
    const user = seedEmployee();
    const cookie = newCookieOf(await login());
    user.isActive = false;

    const res = await refresh(cookie);

    expect(res.body.code).toBe("ACCOUNT_INACTIVE");
    expect(isClearing(res)).toBe(true);
  });

  it("an expired refresh token clears it", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    store.refreshTokens[0]!.expiresAt = new Date(Date.now() - 1000);

    const res = await refresh(cookie);

    expect(res.body.code).toBe("INVALID_REFRESH_TOKEN");
    expect(isClearing(res)).toBe(true);
  });

  it("a database failure while reading the token (500) does not clear it, and the cookie still works afterwards", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const find = vi
      .spyOn(InMemoryAuthRepository.prototype, "findRefreshTokenByHash")
      .mockRejectedValueOnce(new Error("connection terminated"));

    const failed = await refresh(cookie);

    expect(failed.status).toBe(500);
    expect(failed.body.code).toBe("INTERNAL_ERROR");
    expect(refreshCookies(failed)).toHaveLength(0);
    find.mockRestore();
    const again = await refresh(cookie);
    expect(again.status).toBe(200);
  });

  it("a database failure while rotating (500) does not clear it and spends nothing", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(InMemoryAuthRepository.prototype, "rotateRefreshToken").mockRejectedValueOnce(
      new Error("deadlock detected"),
    );

    const failed = await refresh(cookie);

    expect(failed.status).toBe(500);
    expect(refreshCookies(failed)).toHaveLength(0);
    expect(liveRows()).toHaveLength(1);
    expect((await refresh(cookie)).status).toBe(200);
  });

  it("an unexpected error of any kind leaves the cookie alone", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.spyOn(InMemoryAuthRepository.prototype, "findRefreshTokenByHash").mockImplementationOnce(() => {
      throw new TypeError("something nobody expected");
    });

    const failed = await refresh(cookie);

    expect(failed.status).toBe(500);
    expect(refreshCookies(failed)).toHaveLength(0);
  });

  it("a conflict (409) does not clear it", async () => {
    seedEmployee();
    const cookie = newCookieOf(await login());
    await refresh(cookie);

    const res = await refresh(cookie);

    expect(res.status).toBe(409);
    expect(refreshCookies(res)).toHaveLength(0);
  });
});
