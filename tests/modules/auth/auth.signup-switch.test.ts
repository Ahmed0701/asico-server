import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "./in-memory-auth.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("./in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/auth/repository/auth.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/auth/repository/auth.repository.js")>()),
  AuthRepository: (await import("./in-memory-auth.repository.js")).InMemoryAuthRepository,
}));

import { createApp } from "../../../src/app.js";
import { env, envSchema, signupEnabled } from "../../../src/core/config/env.js";

// POST /auth/signup and its switch: a production server only gets users created by an administrator (POST /users).
const app = createApp();
const body = { name: "New Person", email: "new.person@example.test", password: "Correct-Horse-9" };
const signup = (payload: unknown = body, language = "en") =>
  request(app)
    .post("/api/v1/auth/signup")
    .set("Accept-Language", language)
    .send(payload as object);

beforeEach(() => {
  store.reset();
});
afterEach(() => {
  env.NODE_ENV = "test";
  env.AUTH_SIGNUP_ENABLED = undefined;
});

describe("signupEnabled", () => {
  it.each([
    ["development", undefined, true],
    ["test", undefined, true],
    ["production", undefined, false],
    ["production", true, true],
    ["development", false, false],
  ] as const)("NODE_ENV=%s, AUTH_SIGNUP_ENABLED=%s -> %s", (nodeEnv, flag, expected) => {
    expect(signupEnabled({ NODE_ENV: nodeEnv, AUTH_SIGNUP_ENABLED: flag })).toBe(expected);
  });

  it("reads the words true and false, a blank value as unset, and refuses anything else", () => {
    const base = {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://u:p@localhost:5432/d",
      JWT_ACCESS_SECRET: "x".repeat(32),
    };

    expect(envSchema.parse({ ...base, AUTH_SIGNUP_ENABLED: "false" }).AUTH_SIGNUP_ENABLED).toBe(false);
    expect(envSchema.parse({ ...base, AUTH_SIGNUP_ENABLED: "true" }).AUTH_SIGNUP_ENABLED).toBe(true);
    expect(envSchema.parse({ ...base, AUTH_SIGNUP_ENABLED: "" }).AUTH_SIGNUP_ENABLED).toBeUndefined();
    expect(envSchema.safeParse({ ...base, AUTH_SIGNUP_ENABLED: "no" }).success).toBe(false);
  });
});

describe("POST /auth/signup with sign-up closed", () => {
  it("is refused with 403 SIGNUP_DISABLED in production by default, and creates no user", async () => {
    env.NODE_ENV = "production";

    const res = await signup();

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SIGNUP_DISABLED");
    expect(res.body.message).toBe("Sign-up is turned off. Ask an administrator to create your account.");
    expect(store.users).toHaveLength(0);
  });

  it("answers the same before reading the body, and in the request's language", async () => {
    env.AUTH_SIGNUP_ENABLED = false;

    const invalid = await signup({ email: "not-an-email" });
    const arabic = await signup(body, "ar");

    expect(invalid.status).toBe(403);
    expect(invalid.body.code).toBe("SIGNUP_DISABLED");
    expect(arabic.body.message).toBe("التسجيل الذاتي متوقف. اطلب من المسؤول إنشاء حسابك.");
  });

  it("stays open in production when AUTH_SIGNUP_ENABLED=true", async () => {
    env.NODE_ENV = "production";
    env.AUTH_SIGNUP_ENABLED = true;

    const res = await signup();

    expect(res.status).toBe(201);
    expect(store.users).toHaveLength(1);
  });
});
