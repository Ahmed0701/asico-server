import { describe, expect, it } from "vitest";
import { envSchema } from "../../src/core/config/env.js";

const required = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://asico:asico@localhost:5432/asico",
  JWT_ACCESS_SECRET: "x".repeat(32),
};

describe("environment defaults for exports and uploads", () => {
  it("allows 10 exports per minute for each user by default", () => {
    const env = envSchema.parse(required);

    expect(env.EXPORT_RATE_LIMIT_MAX).toBe(10);
    expect(env.EXPORT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("reads the export limit and window from the environment", () => {
    const env = envSchema.parse({
      ...required,
      EXPORT_RATE_LIMIT_MAX: "3",
      EXPORT_RATE_LIMIT_WINDOW_MS: "1000",
    });

    expect(env.EXPORT_RATE_LIMIT_MAX).toBe(3);
    expect(env.EXPORT_RATE_LIMIT_WINDOW_MS).toBe(1000);
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects an export limit of %s", (value) => {
    expect(envSchema.safeParse({ ...required, EXPORT_RATE_LIMIT_MAX: value }).success).toBe(false);
  });

  it("keeps the upload defaults: 25 MB and 10 documents per villa", () => {
    const env = envSchema.parse(required);

    expect(env.MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(env.MAX_DOCUMENTS_PER_VILLA).toBe(10);
  });
});

describe("outgoing mail settings", () => {
  const smtp = {
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "asico@gmail.com",
    SMTP_PASS: "abcdefghijklmnop",
    MAIL_FROM: "Asico <asico@gmail.com>",
  };
  const production = { ...required, NODE_ENV: "production" };
  const issuesOf = (input: Record<string, unknown>) => {
    const result = envSchema.safeParse(input);
    return result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  };

  it("are all optional in development and test", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const env = envSchema.parse({ ...required, NODE_ENV });

      expect(env.SMTP_HOST).toBeUndefined();
      expect(env.MAIL_FROM).toBeUndefined();
    }
  });

  it("are parsed: the port as a number, the secure flag from its words", () => {
    const env = envSchema.parse({ ...required, ...smtp });

    expect(env).toMatchObject({
      SMTP_HOST: "smtp.gmail.com",
      SMTP_PORT: 465,
      SMTP_SECURE: true,
      SMTP_USER: "asico@gmail.com",
      MAIL_FROM: "Asico <asico@gmail.com>",
    });
    expect(envSchema.parse({ ...required, ...smtp, SMTP_PORT: "587", SMTP_SECURE: "false" })).toMatchObject({
      SMTP_PORT: 587,
      SMTP_SECURE: false,
    });
  });

  it("treat a blank value as not set", () => {
    const env = envSchema.parse({
      ...required,
      SMTP_HOST: "",
      SMTP_PORT: "  ",
      SMTP_PASS: "",
      MAIL_FROM: "",
    });

    expect(env.SMTP_HOST).toBeUndefined();
    expect(env.SMTP_PORT).toBeUndefined();
    expect(env.SMTP_PASS).toBeUndefined();
  });

  describe("in production", () => {
    it("are all required: the app does not start without them", () => {
      expect(issuesOf(production).map((issue) => issue.split(":")[0])).toEqual([
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_SECURE",
        "SMTP_USER",
        "SMTP_PASS",
        "MAIL_FROM",
      ]);
      expect(issuesOf(production)[0]).toMatch(/required in production/);
    });

    it("names only what is missing", () => {
      const withoutPass = Object.fromEntries(Object.entries(smtp).filter(([name]) => name !== "SMTP_PASS"));

      expect(issuesOf({ ...production, ...withoutPass })).toEqual([
        expect.stringMatching(/^SMTP_PASS: is required in production/),
      ]);
    });

    it("start when everything is there", () => {
      expect(envSchema.safeParse({ ...production, ...smtp }).success).toBe(true);
    });
  });

  it("are all-or-nothing in development: one setting alone is an error", () => {
    const problems = issuesOf({ ...required, NODE_ENV: "development", SMTP_HOST: "smtp.gmail.com" });

    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatch(/required when any other SMTP setting is given/);
  });

  it.each([
    ["SMTP_SECURE", "yes"],
    ["SMTP_SECURE", "1"],
    ["SMTP_SECURE", "TRUE"],
    ["SMTP_PORT", "0"],
    ["SMTP_PORT", "70000"],
    ["SMTP_PORT", "abc"],
    ["SMTP_PORT", "465.5"],
    ["MAIL_FROM", "not an address"],
    ["MAIL_FROM", "Asico <not-an-address>"],
    ["MAIL_FROM", "asico@gmail.com\r\nBcc: attacker@example.test"],
    ["MAIL_FROM", "Asico <asico@gmail.com>, other@example.test"],
  ])("reject %s = %j", (name, value) => {
    expect(envSchema.safeParse({ ...required, ...smtp, [name]: value }).success).toBe(false);
  });

  it.each([
    "asico@gmail.com",
    "Asico <asico@gmail.com>",
    '"Asico, Inc" <asico@gmail.com>',
    "Asico Team <ASICO@Gmail.com>",
  ])("accept MAIL_FROM = %j", (value) => {
    expect(envSchema.safeParse({ ...required, ...smtp, MAIL_FROM: value }).success).toBe(true);
  });

  it("reject an App Password with spaces, without repeating it", () => {
    const pass = "abcd efgh ijkl mnop";
    const result = envSchema.safeParse({ ...required, ...smtp, SMTP_PASS: pass });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain("abcd");
    expect(JSON.stringify(result.error?.issues)).toMatch(/no spaces/);
  });

  describe("for Gmail", () => {
    it("MAIL_FROM must be the authenticated account, whatever the case", () => {
      expect(issuesOf({ ...required, ...smtp, MAIL_FROM: "Asico <someone.else@gmail.com>" })).toEqual([
        "MAIL_FROM: must be the Gmail account in SMTP_USER",
      ]);
      expect(envSchema.safeParse({ ...required, ...smtp, SMTP_USER: "Asico@Gmail.com" }).success).toBe(true);
    });

    it("another provider may send as another address", () => {
      expect(
        envSchema.safeParse({
          ...required,
          ...smtp,
          SMTP_HOST: "smtp.example.test",
          MAIL_FROM: "noreply@example.test",
        }).success,
      ).toBe(true);
    });
  });
});

describe("PASSWORD_RESET_URL", () => {
  it.each(["javascript:alert(1)", "ftp://example.test/reset", "data:text/html,x", "mailto:a@b.test"])(
    "rejects %s",
    (value) => {
      expect(envSchema.safeParse({ ...required, PASSWORD_RESET_URL: value }).success).toBe(false);
    },
  );

  it.each(["http://localhost:5173/reset-password", "https://app.example.test/reset-password"])(
    "accepts %s",
    (value) => {
      expect(envSchema.parse({ ...required, PASSWORD_RESET_URL: value }).PASSWORD_RESET_URL).toBe(value);
    },
  );
});

describe("environment defaults for imports", () => {
  it("allows 10 imports per minute for each user by default, like exports", () => {
    const env = envSchema.parse(required);

    expect(env.IMPORT_RATE_LIMIT_MAX).toBe(10);
    expect(env.IMPORT_RATE_LIMIT_WINDOW_MS).toBe(60_000);
  });

  it("reads the import limit and window from the environment, apart from the export ones", () => {
    const env = envSchema.parse({
      ...required,
      IMPORT_RATE_LIMIT_MAX: "2",
      IMPORT_RATE_LIMIT_WINDOW_MS: "5000",
    });

    expect(env.IMPORT_RATE_LIMIT_MAX).toBe(2);
    expect(env.IMPORT_RATE_LIMIT_WINDOW_MS).toBe(5000);
    expect(env.EXPORT_RATE_LIMIT_MAX).toBe(10);
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects an import limit of %s", (value) => {
    expect(envSchema.safeParse({ ...required, IMPORT_RATE_LIMIT_MAX: value }).success).toBe(false);
  });
});

describe("environment defaults for the refresh endpoint", () => {
  it("allows 30 refreshes per minute for each client by default, apart from the sign-in limit", () => {
    const env = envSchema.parse(required);

    expect(env.REFRESH_RATE_LIMIT_MAX).toBe(30);
    expect(env.REFRESH_RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(env.AUTH_RATE_LIMIT_MAX).toBe(10);
    expect(env.AUTH_RATE_LIMIT_WINDOW_MS).toBe(900_000);
  });

  it("reads the refresh limit and window from the environment, apart from the auth ones", () => {
    const env = envSchema.parse({
      ...required,
      REFRESH_RATE_LIMIT_MAX: "4",
      REFRESH_RATE_LIMIT_WINDOW_MS: "5000",
    });

    expect(env.REFRESH_RATE_LIMIT_MAX).toBe(4);
    expect(env.REFRESH_RATE_LIMIT_WINDOW_MS).toBe(5000);
    expect(env.AUTH_RATE_LIMIT_MAX).toBe(10);
  });

  it.each(["0", "-1", "abc", "1.5"])("rejects a refresh limit of %s", (value) => {
    expect(envSchema.safeParse({ ...required, REFRESH_RATE_LIMIT_MAX: value }).success).toBe(false);
    expect(envSchema.safeParse({ ...required, REFRESH_RATE_LIMIT_WINDOW_MS: value }).success).toBe(false);
  });
});

describe("environment settings of the refresh cookie", () => {
  const issuesOf = (input: Record<string, unknown>) => {
    const result = envSchema.safeParse(input);
    return result.success
      ? []
      : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  };
  // Production needs the mail settings too; they are not what is tested here.
  const mail = {
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "465",
    SMTP_SECURE: "true",
    SMTP_USER: "asico@example.com",
    SMTP_PASS: "abcdefghijklmnop",
    MAIL_FROM: "Asico <asico@example.com>",
  };
  const production = { ...required, ...mail, NODE_ENV: "production" };

  it("defaults to strict, with Secure left to the environment and no domain", () => {
    const env = envSchema.parse(required);

    expect(env.REFRESH_COOKIE_SAMESITE).toBe("strict");
    expect(env.REFRESH_COOKIE_SECURE).toBeUndefined();
    expect(env.REFRESH_COOKIE_DOMAIN).toBeUndefined();
  });

  it("treats blank values as not set", () => {
    const env = envSchema.parse({
      ...required,
      REFRESH_COOKIE_SECURE: "",
      REFRESH_COOKIE_SAMESITE: "  ",
      REFRESH_COOKIE_DOMAIN: "",
    });

    expect(env.REFRESH_COOKIE_SAMESITE).toBe("strict");
    expect(env.REFRESH_COOKIE_SECURE).toBeUndefined();
    expect(env.REFRESH_COOKIE_DOMAIN).toBeUndefined();
  });

  it.each(["strict", "lax"])("accepts SameSite %s with or without Secure in development", (value) => {
    for (const secure of ["true", "false"]) {
      const env = envSchema.parse({
        ...required,
        NODE_ENV: "development",
        REFRESH_COOKIE_SAMESITE: value,
        REFRESH_COOKIE_SECURE: secure,
      });
      expect(env.REFRESH_COOKIE_SAMESITE).toBe(value);
      expect(env.REFRESH_COOKIE_SECURE).toBe(secure === "true");
    }
  });

  it.each(["Strict", "NONE", "unset", "true", "0"])("rejects SameSite %s", (value) => {
    expect(issuesOf({ ...required, REFRESH_COOKIE_SAMESITE: value })).toEqual([
      expect.stringContaining("REFRESH_COOKIE_SAMESITE"),
    ]);
  });

  it.each(["yes", "1", "TRUE", "on"])("rejects Secure %s (only the words true and false)", (value) => {
    expect(issuesOf({ ...required, REFRESH_COOKIE_SECURE: value })).toEqual([
      expect.stringContaining("REFRESH_COOKIE_SECURE"),
    ]);
  });

  describe("SameSite=none needs Secure", () => {
    it("is accepted when Secure is on, explicitly or by default", () => {
      expect(
        envSchema.parse({ ...required, REFRESH_COOKIE_SAMESITE: "none", REFRESH_COOKIE_SECURE: "true" })
          .REFRESH_COOKIE_SAMESITE,
      ).toBe("none");
      // NODE_ENV=test is secure by default, like production.
      expect(envSchema.parse({ ...required, REFRESH_COOKIE_SAMESITE: "none" }).REFRESH_COOKIE_SAMESITE).toBe(
        "none",
      );
      expect(
        envSchema.parse({ ...production, REFRESH_COOKIE_SAMESITE: "none" }).REFRESH_COOKIE_SAMESITE,
      ).toBe("none");
    });

    it("is refused when Secure is switched off", () => {
      expect(
        issuesOf({ ...required, REFRESH_COOKIE_SAMESITE: "none", REFRESH_COOKIE_SECURE: "false" }),
      ).toEqual([expect.stringMatching(/^REFRESH_COOKIE_SAMESITE: none needs a secure cookie/)]);
    });

    it("is refused in development, where Secure is off by default", () => {
      expect(issuesOf({ ...required, NODE_ENV: "development", REFRESH_COOKIE_SAMESITE: "none" })).toEqual([
        expect.stringMatching(/^REFRESH_COOKIE_SAMESITE: none needs a secure cookie/),
      ]);
    });

    it("is accepted in development once Secure is switched on", () => {
      const env = envSchema.parse({
        ...required,
        NODE_ENV: "development",
        REFRESH_COOKIE_SAMESITE: "none",
        REFRESH_COOKIE_SECURE: "true",
      });

      expect(env.REFRESH_COOKIE_SAMESITE).toBe("none");
    });
  });

  describe("Secure in production", () => {
    it("cannot be switched off", () => {
      expect(issuesOf({ ...production, REFRESH_COOKIE_SECURE: "false" })).toEqual([
        expect.stringMatching(/^REFRESH_COOKIE_SECURE: must not be false in production/),
      ]);
    });

    it("can be left unset or set to true", () => {
      expect(issuesOf(production)).toEqual([]);
      expect(issuesOf({ ...production, REFRESH_COOKIE_SECURE: "true" })).toEqual([]);
    });

    it("may be false in development and test, where there is no TLS to rely on", () => {
      expect(issuesOf({ ...required, NODE_ENV: "development", REFRESH_COOKIE_SECURE: "false" })).toEqual([]);
      expect(issuesOf({ ...required, NODE_ENV: "test", REFRESH_COOKIE_SECURE: "false" })).toEqual([]);
    });
  });

  describe("the domain", () => {
    it.each([
      "example.com",
      "api.example.com",
      "localhost",
      "a-b.example.co.uk",
      "EXAMPLE.com",
      "1.example.com",
    ])("accepts %s", (value) => {
      expect(envSchema.parse({ ...required, REFRESH_COOKIE_DOMAIN: value }).REFRESH_COOKIE_DOMAIN).toBe(
        value,
      );
    });

    it("trims the value", () => {
      expect(
        envSchema.parse({ ...required, REFRESH_COOKIE_DOMAIN: " example.com " }).REFRESH_COOKIE_DOMAIN,
      ).toBe("example.com");
    });

    it.each([
      "https://example.com",
      "example.com:8080",
      "example.com/path",
      ".example.com",
      "example.com.",
      "-example.com",
      "example-.com",
      "example.com-",
      "api-.example.com",
      "api.-example.com",
      "exa mple.com",
      "example..com",
      "exämple.com",
      `${"a".repeat(254)}`,
    ])("rejects %s", (value) => {
      expect(issuesOf({ ...required, REFRESH_COOKIE_DOMAIN: value })).toEqual([
        expect.stringContaining("REFRESH_COOKIE_DOMAIN"),
      ]);
    });
  });
});

describe("placeholder values copied from an example file", () => {
  it("refuses any setting that still says CHANGE_ME, naming it", () => {
    const result = envSchema.safeParse({
      ...required,
      JWT_ACCESS_SECRET: "CHANGE_ME_JWT_ACCESS_SECRET_AT_LEAST_32_CHARS",
      DATABASE_URL: "postgresql://elecico:CHANGE_ME_POSTGRES_PASSWORD@db:5432/elecico",
    });

    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues.map((issue) => issue.path.join(".")).sort()).toEqual(["DATABASE_URL", "JWT_ACCESS_SECRET"]);
    expect(issues[0]?.message).toBe("is still a placeholder (CHANGE_ME): set the real value");
  });

  it("matches the marker in any case, and accepts real values", () => {
    expect(
      envSchema.safeParse({ ...required, JWT_ACCESS_SECRET: `change_me_${"x".repeat(32)}` }).success,
    ).toBe(false);
    expect(envSchema.safeParse(required).success).toBe(true);
  });
});
