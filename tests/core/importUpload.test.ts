import { createHash } from "node:crypto";
import express, { type Request } from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../src/core/errors/errorHandler.js";
import { fileHashOf, importFingerprint, receiveImportFile } from "../../src/core/middleware/importUpload.js";
import { IMPORT_MAX_BYTES } from "../../src/shared/import/index.js";

const requestWith = (
  bytes: Buffer | null,
  query: { dryRun?: boolean } | undefined,
  name = "a.xlsx",
): Request =>
  ({
    file: bytes ? { buffer: bytes, originalname: name } : undefined,
    validated: query === undefined ? {} : { query },
  }) as unknown as Request;

describe("fileHashOf", () => {
  it("is the SHA-256 of the bytes, in hex", () => {
    const bytes = Buffer.from("hello");

    expect(fileHashOf(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(fileHashOf(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("importFingerprint", () => {
  const bytes = Buffer.from("one file");

  it("is the file's hash and the dry-run flag", () => {
    expect(importFingerprint(requestWith(bytes, { dryRun: false }))).toBe(
      `import:${fileHashOf(bytes)}:dryRun=false`,
    );
    expect(importFingerprint(requestWith(bytes, { dryRun: true }))).toBe(
      `import:${fileHashOf(bytes)}:dryRun=true`,
    );
  });

  it("differs between a dry run and a real import of the same file", () => {
    expect(importFingerprint(requestWith(bytes, { dryRun: true }))).not.toBe(
      importFingerprint(requestWith(bytes, { dryRun: false })),
    );
  });

  it("differs between two files and ignores the file's name", () => {
    const other = importFingerprint(requestWith(Buffer.from("another file"), { dryRun: false }));

    expect(other).not.toBe(importFingerprint(requestWith(bytes, { dryRun: false })));
    expect(importFingerprint(requestWith(bytes, { dryRun: false }, "x.xlsx"))).toBe(
      importFingerprint(requestWith(bytes, { dryRun: false }, "y.xlsx")),
    );
  });

  it("treats a missing query as a real import and a missing file as no file", () => {
    expect(importFingerprint(requestWith(bytes, undefined))).toBe(`import:${fileHashOf(bytes)}:dryRun=false`);
    expect(importFingerprint(requestWith(null, { dryRun: false }))).toBe("import:no-file:dryRun=false");
  });
});

describe("receiveImportFile", () => {
  const app = express();
  app.use((req, _res, next) => {
    req.locale = "en";
    next();
  });
  app.post("/up", receiveImportFile, (req, res) => void res.json({ size: req.file?.size ?? null }));
  app.use(errorHandler);

  const outcome = (res: request.Response) => ({
    status: res.status,
    code: res.body.code,
    size: res.body.size,
  });

  it("keeps one file, named file, in memory", async () => {
    const res = await request(app).post("/up").attach("file", Buffer.from("abc"), "a.xlsx");

    expect(outcome(res)).toEqual({ status: 200, code: undefined, size: 3 });
  });

  it("accepts a file of exactly the size limit and refuses one byte more with 413", async () => {
    const exact = await request(app).post("/up").attach("file", Buffer.alloc(IMPORT_MAX_BYTES), "a.xlsx");
    const over = await request(app)
      .post("/up")
      .attach("file", Buffer.alloc(IMPORT_MAX_BYTES + 1), "a.xlsx");

    expect(outcome(exact)).toEqual({ status: 200, code: undefined, size: IMPORT_MAX_BYTES });
    expect(outcome(over)).toEqual({ status: 413, code: "FILE_TOO_LARGE", size: undefined });
  });

  it("refuses a second file, whatever its field is called, with TOO_MANY_FILES", async () => {
    const second = await request(app)
      .post("/up")
      .attach("file", Buffer.from("a"), "a.xlsx")
      .attach("other", Buffer.from("b"), "b.xlsx");
    const twice = await request(app)
      .post("/up")
      .attach("file", Buffer.from("a"), "a.xlsx")
      .attach("file", Buffer.from("b"), "b.xlsx");

    expect(outcome(second)).toMatchObject({ status: 400, code: "TOO_MANY_FILES" });
    expect(outcome(twice)).toMatchObject({ status: 400, code: "TOO_MANY_FILES" });
  });

  it("refuses a file under another name with NO_FILE_PROVIDED, and any text field as a bad request", async () => {
    const renamed = await request(app).post("/up").attach("upload", Buffer.from("a"), "a.xlsx");
    const field = await request(app).post("/up").field("note", "hi");

    expect(outcome(renamed)).toMatchObject({ status: 400, code: "NO_FILE_PROVIDED" });
    expect(outcome(field)).toMatchObject({ status: 400, code: "BAD_REQUEST" });
  });
});
