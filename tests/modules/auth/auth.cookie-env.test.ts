import bcrypt from "bcrypt";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "./in-memory-auth.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("./in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/auth/repository/auth.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/auth/repository/auth.repository.js")>()),
  AuthRepository: (await import("./in-memory-auth.repository.js")).InMemoryAuthRepository,
}));

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";

// The refresh cookie's Secure, SameSite and Domain come from the environment (REFRESH_COOKIE_SECURE,
// REFRESH_COOKIE_SAMESITE, REFRESH_COOKIE_DOMAIN). The browser removes a cookie only when the clearing one carries the
// same Path, Domain, Secure and SameSite it was set with, so every place that clears it is checked against the same settings.
const PASSWORD = "Correct-Horse-9";
const app = createApp();

let passwordHash: string;
beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

const original = {
  NODE_ENV: env.NODE_ENV,
  secure: env.REFRESH_COOKIE_SECURE,
  sameSite: env.REFRESH_COOKIE_SAMESITE,
  domain: env.REFRESH_COOKIE_DOMAIN,
};

beforeEach(() => {
  store.reset();
  store.addUser({ email: "sara@example.test", name: "Sara", passwordHash });
});

afterEach(() => {
  env.NODE_ENV = original.NODE_ENV;
  env.REFRESH_COOKIE_SECURE = original.secure;
  env.REFRESH_COOKIE_SAMESITE = original.sameSite;
  env.REFRESH_COOKIE_DOMAIN = original.domain;
});

type Settings = {
  nodeEnv?: "development" | "test" | "production";
  secure?: boolean | undefined;
  sameSite?: "strict" | "lax" | "none";
  domain?: string | undefined;
};

function configure({ nodeEnv = "test", secure, sameSite = "strict", domain }: Settings): void {
  env.NODE_ENV = nodeEnv;
  env.REFRESH_COOKIE_SECURE = secure;
  env.REFRESH_COOKIE_SAMESITE = sameSite;
  env.REFRESH_COOKIE_DOMAIN = domain;
}

type Cookie = { value: string; flags: Set<string>; attributes: Map<string, string> };

function cookieOf(res: request.Response): Cookie {
  const header = (res.headers["set-cookie"] as unknown as string[] | undefined)?.find((cookie) =>
    cookie.startsWith("refresh_token="),
  );
  if (!header) throw new Error("no refresh_token cookie was set");
  const [first = "", ...rest] = header.split(";").map((part) => part.trim());
  const flags = new Set<string>();
  const attributes = new Map<string, string>();
  for (const part of rest) {
    const at = part.indexOf("=");
    if (at === -1) flags.add(part.toLowerCase());
    else attributes.set(part.slice(0, at).toLowerCase(), part.slice(at + 1));
  }
  return { value: first.slice("refresh_token=".length), flags, attributes };
}

const login = () =>
  request(app).post("/api/v1/auth/login").send({ email: "sara@example.test", password: PASSWORD });
const withCookie = (token: string) => `refresh_token=${token}`;

// The attributes that must be the same on the cookie that is set and the one that clears it.
const identity = (cookie: Cookie) => ({
  path: cookie.attributes.get("path"),
  domain: cookie.attributes.get("domain"),
  sameSite: cookie.attributes.get("samesite"),
  secure: cookie.flags.has("secure"),
  httpOnly: cookie.flags.has("httponly"),
});

describe("the defaults", () => {
  it("are Secure, SameSite=Strict, HttpOnly, the auth path, and no Domain", async () => {
    configure({});

    const cookie = cookieOf(await login());

    expect(identity(cookie)).toEqual({
      path: "/api/v1/auth",
      domain: undefined,
      sameSite: "Strict",
      secure: true,
      httpOnly: true,
    });
  });

  it("omit Secure in development only", async () => {
    configure({ nodeEnv: "development" });
    expect(cookieOf(await login()).flags.has("secure")).toBe(false);

    for (const nodeEnv of ["test", "production"] as const) {
      configure({ nodeEnv });
      expect(cookieOf(await login()).flags.has("secure"), nodeEnv).toBe(true);
    }
  });
});

describe("REFRESH_COOKIE_SECURE", () => {
  it("true makes the cookie Secure in development", async () => {
    configure({ nodeEnv: "development", secure: true });

    expect(cookieOf(await login()).flags.has("secure")).toBe(true);
  });

  it("false leaves Secure off outside production", async () => {
    configure({ nodeEnv: "test", secure: false });

    expect(cookieOf(await login()).flags.has("secure")).toBe(false);
  });

  it("is what decides, not the environment name", async () => {
    configure({ nodeEnv: "development", secure: undefined });
    expect(cookieOf(await login()).flags.has("secure")).toBe(false);
    configure({ nodeEnv: "development", secure: true });
    expect(cookieOf(await login()).flags.has("secure")).toBe(true);
  });
});

describe("REFRESH_COOKIE_SAMESITE", () => {
  it.each([
    ["strict", "Strict"],
    ["lax", "Lax"],
    ["none", "None"],
  ] as const)("%s is sent as SameSite=%s", async (sameSite, expected) => {
    configure({ sameSite });

    expect(cookieOf(await login()).attributes.get("samesite")).toBe(expected);
  });
});

describe("REFRESH_COOKIE_DOMAIN", () => {
  it("is added to the cookie when set", async () => {
    configure({ domain: "example.com" });

    expect(cookieOf(await login()).attributes.get("domain")).toBe("example.com");
  });

  it("is left out when it is not set", async () => {
    configure({ domain: undefined });

    expect(cookieOf(await login()).attributes.has("domain")).toBe(false);
  });
});

describe("the same settings everywhere the cookie is set or cleared", () => {
  const cases: [string, Settings][] = [
    ["the defaults", {}],
    ["lax in development, no Secure", { nodeEnv: "development", sameSite: "lax" }],
    ["none with Secure and a domain", { sameSite: "none", secure: true, domain: "example.com" }],
    ["strict with a domain", { domain: "api.example.com" }],
    ["production with a domain", { nodeEnv: "production", sameSite: "lax", domain: "example.com" }],
  ];

  it.each(cases)("%s: login, refresh, logout and a dead cookie agree", async (_name, settings) => {
    configure(settings);
    const logged = cookieOf(await login());
    const expected = identity(logged);

    const refreshed = await request(app).post("/api/v1/auth/refresh").set("Cookie", withCookie(logged.value));
    expect(refreshed.status).toBe(200);
    expect(identity(cookieOf(refreshed))).toEqual(expected);

    const loggedOut = await request(app)
      .post("/api/v1/auth/logout")
      .set("Cookie", withCookie(cookieOf(refreshed).value));
    expect(loggedOut.status).toBe(204);
    const cleared = cookieOf(loggedOut);
    expect(identity(cleared)).toEqual(expected);
    expect(cleared.value).toBe("");
    expect(new Date(cleared.attributes.get("expires") ?? "").getTime()).toBeLessThan(Date.now());

    // A cookie the server judges dead is cleared with the same attributes too.
    const dead = await request(app).post("/api/v1/auth/refresh").set("Cookie", withCookie("not-a-token"));
    expect(dead.status).toBe(401);
    expect(identity(cookieOf(dead))).toEqual(expected);
  });

  it("a password reset clears the cookie with the same settings", async () => {
    configure({ sameSite: "none", secure: true, domain: "example.com" });
    const expected = identity(cookieOf(await login()));

    const res = await request(app)
      .post("/api/v1/auth/reset-password")
      .send({ token: "x".repeat(40), password: "Another-Strong-Pass-9" });

    // The token is not a real one, so nothing is reset; what matters is that no cookie is set under other settings.
    const header = (res.headers["set-cookie"] as unknown as string[] | undefined) ?? [];
    for (const cookie of header.filter((candidate) => candidate.startsWith("refresh_token="))) {
      expect(
        identity(cookieOf({ headers: { "set-cookie": [cookie] } } as unknown as request.Response)),
      ).toEqual(expected);
    }
  });
});

describe("the cookie is read per request", () => {
  it("a change of setting applies to the next response, without a restart", async () => {
    configure({ sameSite: "strict" });
    expect(cookieOf(await login()).attributes.get("samesite")).toBe("Strict");

    configure({ sameSite: "lax", domain: "example.com" });
    const next = cookieOf(await login());

    expect(next.attributes.get("samesite")).toBe("Lax");
    expect(next.attributes.get("domain")).toBe("example.com");
  });
});
