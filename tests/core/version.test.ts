import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  assertVersion,
  etagOf,
  ifMatch,
  lockVersion,
  parseIfMatch,
  setVersionHeaders,
  versionConflict,
} from "../../src/core/concurrency/version.js";
import { AppError } from "../../src/core/errors/AppError.js";
import { errorHandler } from "../../src/core/errors/errorHandler.js";
import { requestContext } from "../../src/core/middleware/requestContext.js";

describe("parseIfMatch", () => {
  it("reads a version as a plain number, quoted, or as a weak entity tag", () => {
    for (const header of ["3", '"3"', 'W/"3"', " 3 ", "007"]) {
      expect(parseIfMatch(header), header).toEqual({
        kind: "version",
        version: header.includes("007") ? 7 : 3,
      });
    }
  });

  it("is none when the header is absent, and any for *", () => {
    expect(parseIfMatch(undefined)).toEqual({ kind: "none" });
    expect(parseIfMatch("*")).toEqual({ kind: "any" });
    expect(parseIfMatch(" * ")).toEqual({ kind: "any" });
  });

  it("accepts the largest version a column can hold", () => {
    expect(parseIfMatch("2147483647")).toEqual({ kind: "version", version: 2_147_483_647 });
  });

  it.each([
    "",
    "abc",
    "0",
    "-1",
    "1.5",
    "1e3",
    "3,4",
    '"3", "4"',
    "W/3x",
    '""',
    "2147483648",
    "99999999999",
    "0x10",
    "٣",
    "3 4",
    "null",
  ])("refuses %j", (header) => {
    expect(parseIfMatch(header)).toEqual({ kind: "invalid" });
  });
});

describe("ifMatch()", () => {
  function appWith(required = false) {
    const app = express();
    app.use(requestContext);
    app.get("/x", ifMatch({ required }), (req, res) => {
      res.json({ expected: req.expectedVersion ?? null });
    });
    app.use(errorHandler);
    return app;
  }

  it("puts the version on the request, and leaves it unset without a header or with *", async () => {
    expect((await request(appWith()).get("/x").set("If-Match", '"4"')).body.expected).toBe(4);
    expect((await request(appWith()).get("/x")).body.expected).toBeNull();
    expect((await request(appWith()).get("/x").set("If-Match", "*")).body.expected).toBeNull();
  });

  it("answers 400 INVALID_IF_MATCH for a header it cannot read, in the language of the request", async () => {
    const res = await request(appWith()).get("/x").set("If-Match", "abc").set("Accept-Language", "ar");

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_IF_MATCH");
    expect(res.body.message).toBe("يجب أن تكون ترويسة If-Match رقم إصدار واحدًا، مثل 3");
  });

  it("with required: true answers 428 IF_MATCH_REQUIRED without the header, and accepts one with it", async () => {
    const app = appWith(true);

    const missing = await request(app).get("/x");
    const present = await request(app).get("/x").set("If-Match", "2");

    expect(missing.status).toBe(428);
    expect(missing.body.code).toBe("IF_MATCH_REQUIRED");
    expect(present.status).toBe(200);
    expect(present.body.expected).toBe(2);
  });

  it("with required: true still refuses a malformed header with 400, not 428", async () => {
    expect((await request(appWith(true)).get("/x").set("If-Match", "nope")).status).toBe(400);
  });
});

describe("assertVersion and versionConflict", () => {
  it("lets a matching or absent version through", () => {
    expect(() => assertVersion("en", 5, 5)).not.toThrow();
    expect(() => assertVersion("en", undefined, 5)).not.toThrow();
  });

  it("refuses any other version with 409 VERSION_CONFLICT carrying the current one, higher or lower", () => {
    for (const expected of [1, 4, 6, 100]) {
      let error: unknown;
      try {
        assertVersion("en", expected, 5);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        statusCode: 409,
        code: "VERSION_CONFLICT",
        message: "This record was changed by someone else. Reload it and try again",
        details: [{ path: "version", message: "Current version", value: 5 }],
      });
    }
  });

  it("is written in Arabic for an Arabic request", () => {
    const error = versionConflict("ar", 9);

    expect(error.message).toBe("تم تعديل هذا السجل بواسطة شخص آخر. أعد تحميله وحاول مرة أخرى");
    expect(error.details).toEqual([{ path: "version", message: "الإصدار الحالي", value: 9 }]);
  });

  it("reaches the client with the value in the details", async () => {
    const app = express();
    app.use(requestContext);
    app.get("/x", (req) => {
      throw versionConflict(req.locale, 12);
    });
    app.use(errorHandler);

    const res = await request(app).get("/x");

    expect(res.status).toBe(409);
    expect(res.body.details).toEqual([{ path: "version", message: "Current version", value: 12 }]);
  });
});

describe("etagOf", () => {
  it("is the version in quotes", () => {
    expect(etagOf(7)).toBe('"7"');
  });
});

describe("lockVersion", () => {
  const dbReturning = (rows: { version: number }[]) => {
    const queryRaw = vi.fn().mockResolvedValue(rows);
    return { db: { $queryRaw: queryRaw } as never, queryRaw };
  };

  it("asks for the row with FOR UPDATE and returns its version, or null when there is none", async () => {
    const found = dbReturning([{ version: 4 }]);
    const missing = dbReturning([]);

    expect(await lockVersion(found.db, "Villa", "id-1")).toBe(4);
    expect(await lockVersion(missing.db, "User", "id-2")).toBeNull();

    const [sql] = found.queryRaw.mock.calls[0] as [{ strings: string[]; values: unknown[] }];
    const text = sql.strings.join("?");
    expect(text).toMatch(/SELECT "version" FROM .*"Villa".* WHERE "id" = \? FOR UPDATE/);
    expect(sql.values).toContain("id-1");
  });

  it("puts the id in as a parameter, never in the text of the statement", async () => {
    const { db, queryRaw } = dbReturning([{ version: 1 }]);

    await lockVersion(db, "Contractor", 'x\'; DROP TABLE "User"; --');

    const [sql] = queryRaw.mock.calls[0] as [{ strings: string[]; values: unknown[] }];
    expect(sql.strings.join("?")).not.toContain("DROP");
    expect(sql.values).toContain('x\'; DROP TABLE "User"; --');
  });
});

describe("setVersionHeaders()", () => {
  const app = express();
  app.get("/item", (_req, res) => {
    setVersionHeaders(res, 12);
    res.status(200).json({ data: { value: "now" } });
  });

  it("sets the ETag to the quoted version and forbids storing the response", async () => {
    const res = await request(app).get("/item");

    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toBe('"12"');
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });

  it.each([
    ["the same tag", { "If-None-Match": '"12"' }],
    ["a weak form of it", { "If-None-Match": 'W/"12"' }],
    ["any tag", { "If-None-Match": "*" }],
    ["a date in the future", { "If-Modified-Since": new Date(Date.now() + 86_400_000).toUTCString() }],
  ])("answers the full body, not 304, to %s", async (_name, headers) => {
    const res = await request(app).get("/item").set(headers);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: { value: "now" } });
    expect(res.headers["etag"]).toBe('"12"');
  });

  it("does not take If-Match away: a write still reads the version the client sent", async () => {
    let seen: string | undefined;
    const writes = express();
    writes.patch("/item", (req, res) => {
      setVersionHeaders(res, 13);
      seen = req.headers["if-match"];
      res.status(200).json({});
    });

    await request(writes).patch("/item").set("If-Match", '"12"');

    expect(seen).toBe('"12"');
  });
});

// The rule is kept in one place: a module that wrote the ETag itself would bring the stale-304 bug back.
describe("the ETag of an item", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") ? [path] : [];
    });

  it("is set only by setVersionHeaders, never by hand in a module", () => {
    const offenders = walk("src").filter(
      (file) =>
        /setHeader\(\s*["']ETag["']/i.test(readFileSync(file, "utf8")) && !file.endsWith("version.ts"),
    );

    expect(offenders).toEqual([]);
  });
});
