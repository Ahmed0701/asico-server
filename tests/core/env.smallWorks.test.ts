import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/core/config/env.js";

const required = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://asico:asico@localhost:5432/asico",
  JWT_ACCESS_SECRET: "x".repeat(32),
};

describe("small work deadline settings", () => {
  it("defaults to Kuwait, 8 hours and the job on", () => {
    const env = envSchema.parse(required);

    expect(env.APP_TIMEZONE).toBe("Asia/Kuwait");
    expect(env.SMALL_WORKS_ALERT_HOURS_BEFORE).toBe(8);
    expect(env.SMALL_WORKS_ALERT_JOB_ENABLED).toBe(true);
  });

  it("reads them from the environment", () => {
    const env = envSchema.parse({
      ...required,
      APP_TIMEZONE: "Africa/Cairo",
      SMALL_WORKS_ALERT_HOURS_BEFORE: "24",
      SMALL_WORKS_ALERT_JOB_ENABLED: "false",
    });

    expect(env.APP_TIMEZONE).toBe("Africa/Cairo");
    expect(env.SMALL_WORKS_ALERT_HOURS_BEFORE).toBe(24);
    expect(env.SMALL_WORKS_ALERT_JOB_ENABLED).toBe(false);
  });

  it("treats a blank value as unset", () => {
    const env = envSchema.parse({
      ...required,
      APP_TIMEZONE: "",
      SMALL_WORKS_ALERT_HOURS_BEFORE: "",
      SMALL_WORKS_ALERT_JOB_ENABLED: "",
    });

    expect(env.APP_TIMEZONE).toBe("Asia/Kuwait");
    expect(env.SMALL_WORKS_ALERT_HOURS_BEFORE).toBe(8);
    expect(env.SMALL_WORKS_ALERT_JOB_ENABLED).toBe(true);
  });

  it.each(["Mars/Olympus", "+03:00", "Kuwait", "Asia/Kuwait; x"])("rejects the time zone %s", (value) => {
    expect(envSchema.safeParse({ ...required, APP_TIMEZONE: value }).success).toBe(false);
  });

  it.each(["0", "73", "-1", "1.5", "abc"])("rejects %s alert hours", (value) => {
    expect(envSchema.safeParse({ ...required, SMALL_WORKS_ALERT_HOURS_BEFORE: value }).success).toBe(false);
  });

  it.each(["1", "72"])("accepts %s alert hours, the ends of the range", (value) => {
    expect(envSchema.parse({ ...required, SMALL_WORKS_ALERT_HOURS_BEFORE: value })).toMatchObject({
      SMALL_WORKS_ALERT_HOURS_BEFORE: Number(value),
    });
  });

  it.each(["yes", "1", "TRUE"])("rejects the job flag %s", (value) => {
    expect(envSchema.safeParse({ ...required, SMALL_WORKS_ALERT_JOB_ENABLED: value }).success).toBe(false);
  });
});
