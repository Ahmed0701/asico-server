import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";
import { addEngineer, engineerTables } from "../civil-engineers/in-memory-civil-engineers.repository.js";
import { contractorTables } from "../contractors/in-memory-contractors.repository.js";
import { addVilla, villaTables } from "../villas/in-memory-villas.repository.js";
import { idempotencyTable } from "../write-safety/in-memory-idempotency.repository.js";
import { addDocument } from "./in-memory-villa-documents.repository.js";

// A real folder on disk for uploads, made before anything is imported so the storage points at it.
const disk = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join: joinPath } = await import("node:path");
  const base = mkdtempSync(joinPath(tmpdir(), "asico-files-"));
  return { base, root: joinPath(base, "uploads"), failDelete: false, failDeleteDirectory: false };
});

vi.mock("../../../src/core/idempotency/repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/idempotency/repository.js")>()),
  IdempotencyRepository: (await import("../write-safety/in-memory-idempotency.repository.js"))
    .InMemoryIdempotencyRepository,
}));
vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));
vi.mock("../../../src/modules/villas/repository/villas.repository.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/modules/villas/repository/villas.repository.js")>()),
  VillasRepository: (await import("../villas/in-memory-villas.repository.js")).InMemoryVillasRepository,
}));
vi.mock(
  "../../../src/modules/villa-documents/repository/villa-documents.repository.js",
  async (importActual) => ({
    ...(await importActual<
      typeof import("../../../src/modules/villa-documents/repository/villa-documents.repository.js")
    >()),
    VillaDocumentsRepository: (await import("./in-memory-villa-documents.repository.js"))
      .InMemoryVillaDocumentsRepository,
  }),
);
vi.mock("../../../src/core/storage/LocalDiskStorage.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/core/storage/LocalDiskStorage.js")>();
  class TestStorage extends actual.LocalDiskStorage {
    constructor() {
      super(disk.root);
    }
    override async delete(key: string): Promise<void> {
      if (disk.failDelete) throw Object.assign(new Error("EACCES: read-only"), { code: "EACCES" });
      return super.delete(key);
    }
    override async deleteDirectory(prefix: string): Promise<void> {
      if (disk.failDeleteDirectory) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return super.deleteDirectory(prefix);
    }
  }
  return { ...actual, LocalDiskStorage: TestStorage };
});

import { createApp } from "../../../src/app.js";
import { env } from "../../../src/core/config/env.js";
import { logger } from "../../../src/core/config/logger.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import { signFileLink } from "../../../src/core/security/fileLinkToken.js";
import type { User } from "../../../src/generated/prisma/client.js";
import { downloadMode } from "../../../src/modules/villa-documents/controller/villa-documents.controller.js";

const app = createApp();
const MISSING_ID = randomUUID();
const original = {
  NODE_ENV: env.NODE_ENV,
  MAX_UPLOAD_BYTES: env.MAX_UPLOAD_BYTES,
  MAX_DOCUMENTS_PER_VILLA: env.MAX_DOCUMENTS_PER_VILLA,
};

let admin: User;
let villa: ReturnType<typeof addVilla>;
let other: ReturnType<typeof addVilla>;
let engineer: ReturnType<typeof addEngineer>;

beforeEach(async () => {
  vi.restoreAllMocks();
  disk.failDelete = false;
  disk.failDeleteDirectory = false;
  await rm(disk.base, { recursive: true, force: true });
  await mkdir(disk.base, { recursive: true });
  store.reset();
  idempotencyTable.reset();
  engineerTables.reset();
  contractorTables.reset();
  villaTables.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
  engineer = addEngineer({ name: "Mona Hassan", phone: "0100 123 4567" });
  villa = addVilla({ villaNumber: "P-001", civilEngineerId: engineer.id });
  other = addVilla({ villaNumber: "P-002", civilEngineerId: engineer.id });
});

afterEach(() => {
  env.NODE_ENV = original.NODE_ENV;
  env.MAX_UPLOAD_BYTES = original.MAX_UPLOAD_BYTES;
  env.MAX_DOCUMENTS_PER_VILLA = original.MAX_DOCUMENTS_PER_VILLA;
});

afterAll(async () => {
  await rm(disk.base, { recursive: true, force: true });
});

const as = async (user: User): Promise<{ Authorization: string }> => ({
  Authorization: `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`,
});

function employee(email: string, ...codes: string[]): User {
  const user = store.addUser({ name: "Some Employee", email, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

const PDF_BYTES = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n%%EOF\n");
const pdf = (extra = 0): Buffer => Buffer.concat([PDF_BYTES, Buffer.alloc(extra, 0x20)]);

type Attachment = { data?: Buffer; filename?: string; contentType?: string };
const uploadPath = (owner: { id: string }) => `/api/v1/villas/${owner.id}/documents`;

const upload = async (
  { data = pdf(), filename = "plan.pdf", contentType = "application/pdf" }: Attachment = {},
  { user = admin, language = "en", owner = villa as { id: string } } = {},
) =>
  request(app)
    .post(uploadPath(owner))
    .set(await as(user))
    .set("Accept-Language", language)
    .attach("file", data, { filename, contentType });

const asAdmin = async (verb: "get" | "delete", path: string, language = "en") => {
  const agent = request(app);
  const call = verb === "get" ? agent.get(`/api/v1${path}`) : agent.delete(`/api/v1${path}`);
  return call.set(await as(admin)).set("Accept-Language", language);
};

const auditRows = () => store.auditRows as unknown as Record<string, unknown>[];
const tempDir = join(disk.root, ".tmp");
const native = (key: string): string => key.split("/").join(sep);

async function filesUnder(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
  } catch {
    return [];
  }
}
const tempFiles = () => filesUnder(tempDir);
const storedFiles = async () => (await filesUnder(disk.root)).filter((f) => !f.startsWith(".tmp"));

// After any failed upload: nothing half-received, nothing stored, nothing recorded.
async function expectNothingKept(): Promise<void> {
  expect(await tempFiles()).toEqual([]);
  expect(await storedFiles()).toEqual([]);
  expect(villaTables.documents).toHaveLength(0);
  expect(auditRows()).toHaveLength(0);
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("access control", () => {
  const endpoints: [string, () => string, string][] = [
    ["post", () => uploadPath(villa), "villa-documents:upload"],
    ["get", () => `/api/v1/villas/${villa.id}/documents`, "villa-documents:download"],
    ["get", () => `/api/v1/villa-documents/${MISSING_ID}/download`, "villa-documents:download"],
    ["delete", () => `/api/v1/villa-documents/${MISSING_ID}`, "villa-documents:delete"],
  ];
  const allCodes = [
    "villa-documents:upload",
    "villa-documents:download",
    "villa-documents:delete",
    "villas:read",
    "villas:detail",
    "villas:create",
    "villas:update",
    "villas:delete",
    "villas:export",
  ];
  const call = (verb: string, path: string) =>
    (request(app) as unknown as Record<string, (p: string) => request.Test>)[verb]!(path);

  it.each(endpoints)("%s %s requires authentication (401)", async (verb, path) => {
    const res = await call(verb, path());
    expect(res.status).toBe(401);
  });

  it.each(endpoints)(
    "%s %s answers 403 to an employee with no permissions, in Arabic",
    async (verb, path) => {
      const res = await call(verb, path())
        .set(await as(employee("e@example.test")))
        .set("Accept-Language", "ar");

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN", message: "غير مسموح" });
    },
  );

  it.each(endpoints)("%s %s is not opened by any other permission", async (verb, path, needed) => {
    const others = allCodes.filter((code) => code !== needed);

    const res = await call(verb, path()).set(await as(employee("e@example.test", ...others)));

    expect(res.status).toBe(403);
  });

  it.each(endpoints)("%s %s lets the holder of %s through", async (verb, path, needed) => {
    const res = await call(verb, path()).set(await as(employee("e@example.test", needed)));

    expect([401, 403]).not.toContain(res.status);
  });

  it.each(endpoints)("%s %s lets the ADMIN through with no granted permissions", async (verb, path) => {
    const res = await call(verb, path()).set(await as(admin));

    expect([401, 403]).not.toContain(res.status);
  });

  it("an upload without permission is refused before the body is read: nothing is received or stored", async () => {
    const res = await upload({}, { user: employee("e@example.test", "villa-documents:download") });

    expect(res.status).toBe(403);
    await expectNothingKept();
  });

  it("checks access before validating", async () => {
    const res = await request(app)
      .delete("/api/v1/villa-documents/not-an-id")
      .set(await as(employee("e@example.test", "villa-documents:download")));

    expect(res.status).toBe(403);
  });

  it("download needs villa-documents:download even for someone who can upload and delete", async () => {
    const document = addDocument({ villaId: villa.id });
    const res = await request(app)
      .get(`/api/v1/villa-documents/${document.id}/download`)
      .set(
        await as(
          employee("e@example.test", "villa-documents:upload", "villa-documents:delete", "villas:detail"),
        ),
      );

    expect(res.status).toBe(403);
    expect(res.headers["x-accel-redirect"]).toBeUndefined();
  });
});

describe("POST /villas/:villaId/documents", () => {
  it("stores a PDF at a server-made key, records it and audits it", async () => {
    const res = await upload({ filename: "site plan.pdf" });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      id: expect.any(String),
      villaId: villa.id,
      originalName: "site plan.pdf",
      sizeBytes: pdf().length,
      mimeType: "application/pdf",
      uploadedBy: { id: admin.id, name: "Root Admin" },
      createdAt: expect.any(String),
    });
    const row = villaTables.documents[0]!;
    expect(row.storageKey).toMatch(new RegExp(`^villas/${villa.id}/[0-9a-f-]{36}\\.pdf$`));
    expect(await storedFiles()).toEqual([native(row.storageKey)]);
    expect(await readFile(join(disk.root, row.storageKey))).toEqual(pdf());
    expect(await tempFiles()).toEqual([]);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actorId: admin.id,
      action: "villa_document.upload",
      entity: "VillaDocument",
      entityId: row.id,
      after: {
        id: row.id,
        villaId: villa.id,
        originalName: "site plan.pdf",
        sizeBytes: pdf().length,
        mimeType: "application/pdf",
        storageKey: row.storageKey,
      },
    });
  });

  it("does not trust the client's content type or name: it records application/pdf for what is really a PDF", async () => {
    const res = await upload({ filename: "scan.PNG", contentType: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ originalName: "scan.PNG.pdf", mimeType: "application/pdf" });
  });

  it("an employee with villa-documents:upload can upload, and is recorded as the uploader", async () => {
    const worker = employee("w@example.test", "villa-documents:upload");

    const res = await upload({}, { user: worker });

    expect(res.status).toBe(201);
    expect(res.body.data.uploadedBy).toEqual({ id: worker.id, name: "Some Employee" });
    expect(auditRows()[0]).toMatchObject({ actorId: worker.id });
  });

  it("takes several documents for one villa, each stored once", async () => {
    await upload({ filename: "one.pdf" });
    await upload({ filename: "two.pdf" });

    expect(villaTables.documents.map((d) => d.originalName)).toEqual(["one.pdf", "two.pdf"]);
    expect(await storedFiles()).toHaveLength(2);
  });

  describe("what is refused", () => {
    it.each([
      [
        "a Windows executable renamed to .pdf",
        Buffer.from("MZ\u0090\u0000\u0003\u0000\u0000\u0000".padEnd(200, "x")),
        "invoice.pdf",
        "application/pdf",
      ],
      [
        "a text file renamed to .pdf",
        Buffer.from("just some text, not a pdf"),
        "notes.pdf",
        "application/pdf",
      ],
      ["a real .exe name with a PDF content type", Buffer.from("MZ....."), "setup.exe", "application/pdf"],
      [
        "an HTML page that mentions the signature later",
        Buffer.from("<html>%PDF-1.4</html>"),
        "page.pdf",
        "application/pdf",
      ],
      [
        "a PDF with a byte before the signature",
        Buffer.from(` ${pdf().toString()}`),
        "late.pdf",
        "application/pdf",
      ],
      ["an empty file", Buffer.alloc(0), "empty.pdf", "application/pdf"],
      ["a zip", Buffer.from("PK\u0003\u0004rest"), "archive.pdf", "application/zip"],
    ])(
      "%s: 400 INVALID_FILE_TYPE, in Arabic, and nothing is kept",
      async (_label, data, filename, contentType) => {
        const res = await upload({ data, filename, contentType }, { language: "ar" });

        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ code: "INVALID_FILE_TYPE", message: "يُقبل ملف PDF فقط" });
        await expectNothingKept();
      },
    );

    it("a file over the size limit: 413 FILE_TOO_LARGE, in Arabic, and nothing is kept", async () => {
      env.MAX_UPLOAD_BYTES = 1024;

      const res = await upload({ data: pdf(5000) }, { language: "ar" });

      expect(res.status).toBe(413);
      expect(res.body).toMatchObject({
        code: "FILE_TOO_LARGE",
        message: "حجم الملف أكبر من الحد الأقصى المسموح به",
      });
      await expectNothingKept();
    });

    it("accepts a file of exactly the limit and refuses one a byte over", async () => {
      env.MAX_UPLOAD_BYTES = 2048;

      const exact = await upload({ data: pdf(2048 - pdf().length) });
      const over = await upload({ data: pdf(2049 - pdf().length) });

      expect(exact.status).toBe(201);
      expect(exact.body.data.sizeBytes).toBe(2048);
      expect(over.status).toBe(413);
      expect(villaTables.documents).toHaveLength(1);
      expect(await tempFiles()).toEqual([]);
      expect(await storedFiles()).toHaveLength(1);
    });

    it("the 25 MB size limit and the 10 documents per villa come from the environment and are configurable", () => {
      expect(original.MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024);
      expect(original.MAX_DOCUMENTS_PER_VILLA).toBe(10);
    });

    it("a villa that already has the maximum number of documents: 409 VILLA_DOCUMENT_LIMIT, nothing kept", async () => {
      env.MAX_DOCUMENTS_PER_VILLA = 2;
      expect((await upload()).status).toBe(201);
      expect((await upload()).status).toBe(201);

      const res = await upload({}, { language: "ar" });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: "VILLA_DOCUMENT_LIMIT",
        message: "وصلت هذه الفيلا إلى الحد الأقصى لعدد المستندات",
      });
      expect(villaTables.documents).toHaveLength(2);
      expect(await storedFiles()).toHaveLength(2);
      expect(await tempFiles()).toEqual([]);
      expect(auditRows()).toHaveLength(2);
    });

    it("the document limit is per villa: another villa still accepts", async () => {
      env.MAX_DOCUMENTS_PER_VILLA = 1;
      await upload();

      expect((await upload()).status).toBe(409);
      expect((await upload({}, { owner: other })).status).toBe(201);
    });

    it("the limit is checked again inside the transaction: filled by another request in between, 409 and the file is removed", async () => {
      env.MAX_DOCUMENTS_PER_VILLA = 2;
      villaTables.beforeWrite = () => {
        addDocument({ villaId: villa.id, storageKey: "villas/x/one.pdf" });
        addDocument({ villaId: villa.id, storageKey: "villas/x/two.pdf" });
      };

      const res = await upload();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("VILLA_DOCUMENT_LIMIT");
      expect(await storedFiles()).toEqual([]);
      expect(await tempFiles()).toEqual([]);
      expect(villaTables.documents).toHaveLength(2);
      expect(auditRows()).toHaveLength(0);
    });

    it("an unknown villa: 404 VILLA_NOT_FOUND, in Arabic, and the body is never stored", async () => {
      const res = await upload({}, { owner: { id: MISSING_ID }, language: "ar" });

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "VILLA_NOT_FOUND", message: "الفيلا غير موجودة" });
      await expectNothingKept();
    });

    it("malformed id: 400", async () => {
      const res = await request(app)
        .post("/api/v1/villas/not-an-id/documents")
        .set(await as(admin))
        .attach("file", pdf(), { filename: "plan.pdf" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("VALIDATION_ERROR");
      await expectNothingKept();
    });

    it("the old activity upload route is gone", async () => {
      const res = await request(app)
        .post(`/api/v1/villas/${villa.id}/activities/${randomUUID()}/files`)
        .set(await as(admin))
        .attach("file", pdf(), { filename: "plan.pdf" });

      expect(res.status).toBe(404);
      await expectNothingKept();
    });

    it("the villa disappearing before the transaction: 404 VILLA_NOT_FOUND, and the file is removed", async () => {
      villaTables.beforeWrite = () => {
        villaTables.villas = villaTables.villas.filter((v) => v.id !== villa.id);
      };

      const res = await upload();

      expect(res.status).toBe(404);
      expect(res.body.code).toBe("VILLA_NOT_FOUND");
      expect(await storedFiles()).toEqual([]);
      expect(await tempFiles()).toEqual([]);
    });

    it("no multipart body: 400 NO_FILE_PROVIDED", async () => {
      const res = await request(app)
        .post(uploadPath(villa))
        .set(await as(admin))
        .send({ file: "text" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("NO_FILE_PROVIDED");
      await expectNothingKept();
    });

    it("an empty multipart body: 400 NO_FILE_PROVIDED", async () => {
      const res = await request(app)
        .post(uploadPath(villa))
        .set(await as(admin))
        .set("Content-Type", "multipart/form-data; boundary=xyz")
        .send("--xyz--\r\n");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("NO_FILE_PROVIDED");
    });

    it("a file in a field with another name: 400 NO_FILE_PROVIDED, and nothing is kept", async () => {
      const res = await request(app)
        .post(uploadPath(villa))
        .set(await as(admin))
        .set("Accept-Language", "ar")
        .attach("document", pdf(), { filename: "plan.pdf", contentType: "application/pdf" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "NO_FILE_PROVIDED",
        message: 'لم يتم رفع أي ملف. أرسل ملف PDF واحدًا في الحقل "file"',
      });
      await expectNothingKept();
    });

    it("two files in one request: 400 TOO_MANY_FILES, and neither is kept", async () => {
      const res = await request(app)
        .post(uploadPath(villa))
        .set(await as(admin))
        .attach("file", pdf(), { filename: "one.pdf", contentType: "application/pdf" })
        .attach("file", pdf(), { filename: "two.pdf", contentType: "application/pdf" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("TOO_MANY_FILES");
      await expectNothingKept();
    });

    it("a file plus another file under a different name is also refused, and nothing is kept", async () => {
      const res = await request(app)
        .post(uploadPath(villa))
        .set(await as(admin))
        .attach("file", pdf(), { filename: "one.pdf", contentType: "application/pdf" })
        .attach("extra", pdf(), { filename: "two.pdf", contentType: "application/pdf" });

      expect(res.status).toBe(400);
      await expectNothingKept();
    });

    it("a text field next to the file is refused, and nothing is kept", async () => {
      const res = await request(app)
        .post(uploadPath(villa))
        .set(await as(admin))
        .field("note", "hello")
        .attach("file", pdf(), { filename: "plan.pdf", contentType: "application/pdf" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe("BAD_REQUEST");
      await expectNothingKept();
    });

    it("a broken multipart body: 400, and nothing is kept", async () => {
      const res = await request(app)
        .post(uploadPath(villa))
        .set(await as(admin))
        .set("Content-Type", "multipart/form-data; boundary=xyz")
        .send(
          '--xyz\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n%PDF-1.4 cut off',
        );

      expect(res.status).toBe(400);
      await expectNothingKept();
    });

    it("the client dropping the connection mid-upload leaves no temp file behind", async () => {
      const server = app.listen(0);
      await once(server, "listening");
      try {
        const boundary = "abort-boundary";
        const header = await as(admin);
        const req = http.request({
          port: (server.address() as AddressInfo).port,
          method: "POST",
          path: uploadPath(villa),
          headers: {
            ...header,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
            "Content-Length": String(1_000_000),
          },
        });
        req.on("error", () => undefined);
        req.write(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 partial data`,
        );

        await waitFor(async () => (await tempFiles()).length === 1, "the partial upload to reach the disk");
        req.destroy();
        await waitFor(async () => (await tempFiles()).length === 0, "the partial upload to be removed");
      } finally {
        server.close();
      }

      expect(await storedFiles()).toEqual([]);
      expect(villaTables.documents).toHaveLength(0);
    });
  });

  describe("failures after the file has been received", () => {
    it("rolls everything back when the audit write fails: no row, no stored file, no temp file", async () => {
      store.failAuditWith = new Error("audit down");
      vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const res = await upload();

      expect(res.status).toBe(500);
      expect(villaTables.documents).toHaveLength(0);
      expect(await storedFiles()).toEqual([]);
      expect(await tempFiles()).toEqual([]);
      expect(auditRows()).toHaveLength(0);
    });

    it("keeps an earlier document when a later upload is rolled back", async () => {
      await upload({ filename: "first.pdf" });
      store.failAuditWith = new Error("audit down");
      vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const res = await upload({ filename: "second.pdf" });

      expect(res.status).toBe(500);
      expect(villaTables.documents.map((d) => d.originalName)).toEqual(["first.pdf"]);
      expect(await storedFiles()).toHaveLength(1);
      expect(await tempFiles()).toEqual([]);
    });

    it("still reports the failure when the stored file cannot be removed (it is logged as an orphan)", async () => {
      store.failAuditWith = new Error("audit down");
      disk.failDelete = true;
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      vi.spyOn(logger, "error").mockImplementation(() => undefined);

      const res = await upload();

      expect(res.status).toBe(500);
      expect(warn).toHaveBeenCalled();
      expect(villaTables.documents).toHaveLength(0);
      expect(await tempFiles()).toEqual([]);
    });
  });

  describe("names", () => {
    it("keeps an Arabic file name intact", async () => {
      const res = await upload({ filename: "تقرير الموقع.pdf" });

      expect(res.status).toBe(201);
      expect(res.body.data.originalName).toBe("تقرير الموقع.pdf");
      expect(villaTables.documents[0]?.originalName).toBe("تقرير الموقع.pdf");
    });

    it("cannot be made to write outside the upload folder with a hostile file name", async () => {
      for (const filename of [
        "../../../../evil.pdf",
        "..%2F..%2Fevil.pdf",
        "/etc/cron.d/evil.pdf",
        "....//....//evil.pdf",
        "sub/dir/evil.pdf",
      ]) {
        const res = await upload({ filename });
        expect(res.status, filename).toBe(201);
        expect(res.body.data.originalName, filename).not.toMatch(/[\\/]/);
      }

      expect(await readdir(disk.base)).toEqual(["uploads"]);
      const stored = await storedFiles();
      expect(stored).toHaveLength(5);
      for (const file of stored) {
        expect(file.replace(/\\/g, "/")).toMatch(new RegExp(`^villas/${villa.id}/[0-9a-f-]{36}\\.pdf$`));
      }
      expect(await tempFiles()).toEqual([]);
    });
  });
});

describe("GET /villas/:villaId/documents", () => {
  it("lists a villa's documents oldest first, with the full item", async () => {
    await upload({ filename: "a.pdf" });
    await upload({ filename: "b.pdf" });
    await upload({ filename: "c.pdf" });
    await upload({ filename: "other.pdf" }, { owner: other });

    const res = await asAdmin("get", `/villas/${villa.id}/documents`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((d: { originalName: string }) => d.originalName)).toEqual([
      "a.pdf",
      "b.pdf",
      "c.pdf",
    ]);
    expect(res.body.data[0]).toEqual({
      id: expect.any(String),
      villaId: villa.id,
      originalName: "a.pdf",
      sizeBytes: pdf().length,
      mimeType: "application/pdf",
      uploadedBy: { id: admin.id, name: "Root Admin" },
      createdAt: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain("storageKey");
  });

  it("answers an empty list for a villa without documents", async () => {
    expect((await asAdmin("get", `/villas/${villa.id}/documents`)).body).toEqual({ data: [] });
  });

  it("does not list another villa's documents", async () => {
    await upload({ filename: "mine.pdf" });
    await upload({ filename: "other.pdf" }, { owner: other });

    const res = await asAdmin("get", `/villas/${other.id}/documents`);

    expect(res.body.data.map((d: { originalName: string }) => d.originalName)).toEqual(["other.pdf"]);
  });

  it("answers 404 for an unknown villa, in Arabic, and 400 for a malformed id", async () => {
    const missing = await asAdmin("get", `/villas/${MISSING_ID}/documents`, "ar");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "VILLA_NOT_FOUND", message: "الفيلا غير موجودة" });
    expect((await asAdmin("get", "/villas/nope/documents")).status).toBe(400);
  });

  it("the old file list routes are gone", async () => {
    expect((await asAdmin("get", `/villas/${villa.id}/files`)).status).toBe(404);
    expect((await asAdmin("get", `/villas/${villa.id}/activities/${MISSING_ID}/files`)).status).toBe(404);
  });
});

describe("GET /villa-documents/:id/download", () => {
  const seedDocument = async (filename = "plan.pdf", language = "en") => {
    const res = await upload({ filename, data: pdf(100) }, { language });
    expect(res.status).toBe(201);
    return villaTables.documents.find((d) => d.id === res.body.data.id)!;
  };
  const download = async (id: string, language = "en") =>
    asAdmin("get", `/villa-documents/${id}/download`, language);

  describe("production mode: nginx serves the file", () => {
    it("answers with X-Accel-Redirect and the download headers, and an empty body", async () => {
      const document = await seedDocument();

      const res = await download(document.id);

      expect(res.status).toBe(200);
      expect(res.headers["x-accel-redirect"]).toBe(`/protected-files/${document.storageKey}`);
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="plan.pdf"; filename*=UTF-8''plan.pdf`,
      );
      expect(res.headers["content-language"]).toBe("en");
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.text ?? "").toBe("");
      expect(res.body).toHaveLength(0);
    });

    it("is the same in the test environment and in production, and Node does not read the file", async () => {
      const document = await seedDocument();
      await rm(join(disk.root, document.storageKey));

      for (const mode of ["test", "production"] as const) {
        env.NODE_ENV = mode;
        const res = await download(document.id);
        expect(res.status, mode).toBe(200);
        expect(res.headers["x-accel-redirect"], mode).toBe(`/protected-files/${document.storageKey}`);
      }
    });

    it("keeps Content-Language en whatever the request asks for, while errors follow the request language", async () => {
      const document = await seedDocument();

      const ok = await download(document.id, "ar");
      const missing = await download(MISSING_ID, "ar");

      expect(ok.headers["content-language"]).toBe("en");
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ code: "FILE_NOT_FOUND", message: "الملف غير موجود" });
      expect(missing.headers["content-language"]).toBeUndefined();
      expect(missing.headers["x-accel-redirect"]).toBeUndefined();
    });

    it("encodes an Arabic file name as RFC 5987 UTF-8 with an ASCII fallback", async () => {
      const document = await seedDocument("تقرير الموقع.pdf");

      const res = await download(document.id, "ar");

      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="file.pdf"; filename*=UTF-8''${encodeURIComponent("تقرير الموقع.pdf")}`,
      );
      expect(res.headers["content-disposition"]).toMatch(/^[\x20-\x7E]*$/);
      expect(res.headers["content-disposition"]).toContain("%D8%AA%D9%82%D8%B1%D9%8A%D8%B1");
    });

    it("cannot be pointed at another file by a hostile stored name", async () => {
      const document = await seedDocument();
      document.originalName = 'x"; filename="evil.exe';

      const res = await download(document.id);

      expect(res.headers["content-disposition"]?.match(/filename=/g)).toHaveLength(1);
      expect(res.headers["x-accel-redirect"]).toBe(`/protected-files/${document.storageKey}`);
    });

    it("answers 404 for an unknown document and 400 for a malformed id", async () => {
      expect((await download(MISSING_ID)).status).toBe(404);
      expect((await download("nope")).status).toBe(400);
    });
  });

  describe("development mode: this process streams the file", () => {
    beforeEach(() => {
      env.NODE_ENV = "development";
    });

    it("sends the PDF itself with the same headers and no X-Accel-Redirect", async () => {
      const document = await seedDocument("تقرير.pdf");

      const res = await request(app)
        .get(`/api/v1/villa-documents/${document.id}/download`)
        .set(await as(admin))
        .set("Accept-Language", "ar")
        .buffer(true)
        .parse((response: request.Response, done: (err: Error | null, body: Buffer) => void) => {
          const incoming = response as unknown as http.IncomingMessage;
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => done(null, Buffer.concat(chunks)));
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(pdf(100));
      expect(res.headers["content-type"]).toBe("application/pdf");
      expect(res.headers["content-length"]).toBe(String(pdf(100).length));
      expect(res.headers["content-disposition"]).toBe(
        `attachment; filename="file.pdf"; filename*=UTF-8''${encodeURIComponent("تقرير.pdf")}`,
      );
      expect(res.headers["content-language"]).toBe("en");
      expect(res.headers["cache-control"]).toBe("private, no-store");
      expect(res.headers["x-accel-redirect"]).toBeUndefined();
    });

    it("answers 404 FILE_NOT_FOUND, in the request language, when the row exists but the file is gone", async () => {
      const document = await seedDocument();
      await rm(join(disk.root, document.storageKey));

      const res = await download(document.id, "ar");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: "FILE_NOT_FOUND", message: "الملف غير موجود" });
      expect(res.headers["content-type"]).not.toBe("application/pdf");
    });

    it("still needs the download permission", async () => {
      const document = await seedDocument();

      const res = await request(app)
        .get(`/api/v1/villa-documents/${document.id}/download`)
        .set(await as(employee("e@example.test", "villa-documents:upload")));

      expect(res.status).toBe(403);
      expect(res.body).not.toEqual(pdf(100));
    });
  });

  it("downloadMode is development-only streaming, decided per request from NODE_ENV", () => {
    env.NODE_ENV = "development";
    expect(downloadMode()).toBe("stream");
    env.NODE_ENV = "production";
    expect(downloadMode()).toBe("accel");
    env.NODE_ENV = "test";
    expect(downloadMode()).toBe("accel");
  });

  it("FILE_DELIVERY overrides it, so a server without nginx's protected location can stream", () => {
    env.NODE_ENV = "production";
    env.FILE_DELIVERY = "stream";
    expect(downloadMode()).toBe("stream");
    env.NODE_ENV = "development";
    env.FILE_DELIVERY = "accel";
    expect(downloadMode()).toBe("accel");
    env.FILE_DELIVERY = undefined;
  });
});

describe("DELETE /villa-documents/:id", () => {
  const uploadOne = async (filename = "plan.pdf") => {
    const res = await upload({ filename });
    expect(res.status).toBe(201);
    return villaTables.documents.find((d) => d.id === res.body.data.id)!;
  };
  const remove = (id: string, language = "en") => asAdmin("delete", `/villa-documents/${id}`, language);

  it("deletes the row and the file, and answers 204", async () => {
    const document = await uploadOne();

    const res = await remove(document.id);

    expect(res.status).toBe(204);
    expect(res.text).toBe("");
    expect(villaTables.documents).toHaveLength(0);
    expect(await storedFiles()).toEqual([]);
  });

  it("deletes only the document asked for", async () => {
    const first = await uploadOne("one.pdf");
    await uploadOne("two.pdf");

    await remove(first.id);

    expect(villaTables.documents.map((d) => d.originalName)).toEqual(["two.pdf"]);
    expect(await storedFiles()).toHaveLength(1);
  });

  it("writes one audit entry with the before snapshot, including the stored key", async () => {
    const document = await uploadOne();
    const key = document.storageKey;
    store.auditRows.length = 0;

    await remove(document.id);

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      actorId: admin.id,
      action: "villa_document.delete",
      entity: "VillaDocument",
      entityId: document.id,
      before: {
        id: document.id,
        villaId: villa.id,
        originalName: "plan.pdf",
        sizeBytes: pdf().length,
        mimeType: "application/pdf",
        storageKey: key,
      },
    });
    expect(auditRows()[0]).not.toHaveProperty("after");
  });

  it("an employee with villa-documents:delete can delete, and is recorded", async () => {
    const document = await uploadOne();
    const worker = employee("w@example.test", "villa-documents:delete");
    store.auditRows.length = 0;

    const res = await request(app)
      .delete(`/api/v1/villa-documents/${document.id}`)
      .set(await as(worker));

    expect(res.status).toBe(204);
    expect(auditRows()[0]).toMatchObject({ actorId: worker.id, action: "villa_document.delete" });
  });

  it("still answers 204 when the file cannot be removed from disk: the row is gone, the file is an orphan", async () => {
    const document = await uploadOne();
    disk.failDelete = true;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const res = await remove(document.id);

    expect(res.status).toBe(204);
    expect(villaTables.documents).toHaveLength(0);
    expect(await storedFiles()).toEqual([native(document.storageKey)]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ storageKey: document.storageKey }),
      expect.any(String),
    );
  });

  it("still answers 204 when the file is already missing from disk", async () => {
    const document = await uploadOne();
    await rm(join(disk.root, document.storageKey));

    expect((await remove(document.id)).status).toBe(204);
    expect(villaTables.documents).toHaveLength(0);
  });

  it("rolls back and keeps the file on disk when the audit write fails", async () => {
    const document = await uploadOne();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await remove(document.id);

    expect(res.status).toBe(500);
    expect(villaTables.documents).toHaveLength(1);
    expect(await storedFiles()).toHaveLength(1);
  });

  it("answers 404 FILE_NOT_FOUND for an unknown document, and 400 for a malformed id", async () => {
    const missing = await remove(MISSING_ID, "ar");

    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ code: "FILE_NOT_FOUND", message: "الملف غير موجود" });
    expect((await remove("nope")).status).toBe(400);
    expect(auditRows()).toHaveLength(0);
  });

  it("answers 404 when another request deletes it first, and does nothing twice", async () => {
    const document = await uploadOne();
    store.auditRows.length = 0;
    villaTables.beforeWrite = () => {
      villaTables.documents = villaTables.documents.filter((d) => d.id !== document.id);
    };

    const res = await remove(document.id);

    expect(res.status).toBe(404);
    expect(auditRows()).toHaveLength(0);
  });

  it("deleting a document twice: the second is a 404", async () => {
    const document = await uploadOne();

    expect((await remove(document.id)).status).toBe(204);
    expect((await remove(document.id)).status).toBe(404);
  });

  it("a deleted document frees room under the villa's limit", async () => {
    env.MAX_DOCUMENTS_PER_VILLA = 1;
    const document = await uploadOne();
    expect((await upload()).status).toBe(409);

    await remove(document.id);

    expect((await upload()).status).toBe(201);
  });
});

describe("GET /villas/:id (villa detail)", () => {
  it("does not carry the documents: they have their own list", async () => {
    await upload({ filename: "plan.pdf" });

    const res = await asAdmin("get", `/villas/${villa.id}`);

    expect(res.status).toBe(200);
    for (const key of ["documents", "files", "activities"]) {
      expect(res.body.data).not.toHaveProperty(key);
    }
    expect(JSON.stringify(res.body)).not.toContain("storageKey");
  });

  it("a villas:detail holder with no document permission can neither list nor download", async () => {
    await upload({ filename: "plan.pdf" });
    const viewer = await as(employee("v@example.test", "villas:detail"));

    const detail = await request(app).get(`/api/v1/villas/${villa.id}`).set(viewer);
    const list = await request(app).get(`/api/v1/villas/${villa.id}/documents`).set(viewer);
    const download = await request(app)
      .get(`/api/v1/villa-documents/${villaTables.documents[0]!.id}/download`)
      .set(viewer);

    expect(detail.status).toBe(200);
    expect(list.status).toBe(403);
    expect(download.status).toBe(403);
  });
});

describe("DELETE /villas/:id removes the villa's documents from disk", () => {
  it("deletes the folder and the rows, and leaves other villas' documents alone", async () => {
    await upload({ filename: "a.pdf" });
    await upload({ filename: "b.pdf" });
    await upload({ filename: "keep.pdf" }, { owner: other });
    expect(await storedFiles()).toHaveLength(3);

    const res = await request(app)
      .delete(`/api/v1/villas/${villa.id}`)
      .set(await as(admin));

    expect(res.status).toBe(204);
    expect(villaTables.documents.map((d) => d.originalName)).toEqual(["keep.pdf"]);
    const left = await storedFiles();
    expect(left).toHaveLength(1);
    expect(left[0]?.replace(/\\/g, "/")).toContain(`villas/${other.id}/`);
    await expect(stat(join(disk.root, "villas", villa.id))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still answers 204 when the folder cannot be removed", async () => {
    await upload();
    disk.failDeleteDirectory = true;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const res = await request(app)
      .delete(`/api/v1/villas/${villa.id}`)
      .set(await as(admin));

    expect(res.status).toBe(204);
    expect(villaTables.villas.some((p) => p.id === villa.id)).toBe(false);
    expect(await storedFiles()).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ villaId: villa.id }), expect.any(String));
  });

  it("deleting a villa that has no documents is fine", async () => {
    const res = await request(app)
      .delete(`/api/v1/villas/${villa.id}`)
      .set(await as(admin));

    expect(res.status).toBe(204);
  });

  it("leaves the documents alone when the villa delete fails", async () => {
    await upload();
    store.failAuditWith = new Error("audit down");
    vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const res = await request(app)
      .delete(`/api/v1/villas/${villa.id}`)
      .set(await as(admin));

    expect(res.status).toBe(500);
    expect(villaTables.villas.some((p) => p.id === villa.id)).toBe(true);
    expect(await storedFiles()).toHaveLength(1);
    expect(villaTables.documents).toHaveLength(1);
  });
});

describe("an Idempotency-Key on an upload", () => {
  const KEY = "upload-key-0001";
  const keyed = async (
    { data = pdf(), filename = "plan.pdf" }: Attachment = {},
    key: string | null = KEY,
    owner: { id: string } = villa,
  ) => {
    const req = request(app)
      .post(uploadPath(owner))
      .set(await as(admin))
      .attach("file", data, { filename, contentType: "application/pdf" });
    if (key !== null) req.set("Idempotency-Key", key);
    return req;
  };

  it("stores the file once and replays the answer for the same file", async () => {
    const first = await keyed();
    const second = await keyed();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.body).toEqual(first.body);
    expect(villaTables.documents).toHaveLength(1);
    expect(await storedFiles()).toHaveLength(1);
    expect(auditRows().filter((row) => row.action === "villa_document.upload")).toHaveLength(1);
  });

  it("removes the copy a repeated upload left in the temp folder", async () => {
    await keyed();
    await keyed();
    await keyed();

    expect(await tempFiles()).toEqual([]);
  });

  it("two simultaneous identical uploads store one file, and leave no temp file behind", async () => {
    const results = await Promise.all([keyed(), keyed(), keyed()]);

    expect(villaTables.documents).toHaveLength(1);
    expect(results.filter((res) => res.status === 201 && !res.headers["idempotent-replayed"])).toHaveLength(
      1,
    );
    expect(results.every((res) => res.status === 201 || res.status === 409)).toBe(true);
    expect(await tempFiles()).toEqual([]);
  });

  it("is 422 for the same key with another file: other content or other name", async () => {
    await keyed();

    const content = await keyed({ data: pdf(10) });
    const name = await keyed({ filename: "other-name.pdf" });

    for (const res of [content, name]) {
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
    expect(villaTables.documents).toHaveLength(1);
    expect(await storedFiles()).toHaveLength(1);
    expect(await tempFiles()).toEqual([]);
  });

  it("is the same upload whichever villa folder it goes to only if the path is the same", async () => {
    await keyed();

    const elsewhere = await keyed({}, KEY, other);

    expect(elsewhere.status).toBe(422);
  });

  it("is released by a refused upload: the same key can be used for a good file afterwards", async () => {
    const refused = await keyed({ data: Buffer.from("not a pdf at all"), filename: "notes.pdf" });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(idempotencyTable.rows).toHaveLength(0);

    const good = await keyed();

    expect(good.status).toBe(201);
    expect(good.headers["idempotent-replayed"]).toBeUndefined();
    expect(villaTables.documents).toHaveLength(1);
  });

  it("without a key, the same file twice is two documents, as before", async () => {
    await keyed({}, null);
    await keyed({}, null);

    expect(villaTables.documents).toHaveLength(2);
    expect(idempotencyTable.rows).toHaveLength(0);
  });
});

describe("signed links: POST /villa-documents/:id/link and GET /villa-documents/:id/file", () => {
  const uploadedId = async (): Promise<string> => {
    const res = await upload();
    expect(res.status).toBe(201);
    return res.body.data.id as string;
  };
  const askLink = async (id: string, body: Record<string, unknown> = {}, user: User = admin) =>
    request(app)
      .post(`/api/v1/villa-documents/${id}/link`)
      .set(await as(user))
      .send(body);
  // The browser opens the link itself: no Authorization header.
  const open = (url: string) =>
    request(app)
      .get(url)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
      });

  it("needs authentication and the download permission to make a link", async () => {
    const id = await uploadedId();
    expect((await request(app).post(`/api/v1/villa-documents/${id}/link`).send({})).status).toBe(401);
    const res = await askLink(id, {}, employee("e@example.test", "villas:read"));
    expect(res.status).toBe(403);
  });

  it("answers a link for a missing document with 404 and makes none", async () => {
    const res = await askLink(MISSING_ID);
    expect(res.status).toBe(404);
  });

  it("refuses a disposition that is not attachment or inline", async () => {
    const id = await uploadedId();
    expect((await askLink(id, { disposition: "embed" })).status).toBe(400);
  });

  it("gives a link that downloads the whole PDF without any Authorization header", async () => {
    env.NODE_ENV = "development";
    const id = await uploadedId();

    const link = await askLink(id);
    expect(link.status).toBe(200);
    expect(link.body.data.url).toMatch(new RegExp(`^/api/v1/villa-documents/${id}/file\\?token=`));
    expect(Date.parse(link.body.data.expiresAt)).toBeGreaterThan(Date.now());

    const res = await open(link.body.data.url);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="plan\.pdf"/);
    expect(Buffer.compare(res.body as Buffer, pdf())).toBe(0);
  });

  it("an inline link lets the browser show the file in a tab (the View button)", async () => {
    env.NODE_ENV = "development";
    const id = await uploadedId();

    const link = await askLink(id, { disposition: "inline" });
    const res = await open(link.body.data.url);

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toMatch(/^inline; filename="plan\.pdf"/);
    expect(Buffer.compare(res.body as Buffer, pdf())).toBe(0);
  });

  it("hands the file to nginx in accel mode, like the download", async () => {
    const id = await uploadedId();
    const link = await askLink(id);
    const res = await request(app).get(link.body.data.url);
    expect(res.status).toBe(200);
    expect(res.headers["x-accel-redirect"]).toMatch(/^\/protected-files\//);
  });

  it("refuses a link to another document, an expired link, a changed token, and an access token", async () => {
    env.NODE_ENV = "development";
    const id = await uploadedId();
    const otherId = randomUUID();
    const invalid = async (url: string) => {
      const res = await request(app).get(url);
      expect(res.status, url).toBe(401);
      expect(res.body.code).toBe("FILE_LINK_INVALID");
    };

    const forOther = await signFileLink({ documentId: otherId, userId: admin.id, disposition: "attachment" });
    await invalid(`/api/v1/villa-documents/${id}/file?token=${forOther}`);

    const expired = await signFileLink(
      { documentId: id, userId: admin.id, disposition: "attachment" },
      new Date(Date.now() - 5 * 60_000),
    );
    await invalid(`/api/v1/villa-documents/${id}/file?token=${expired}`);

    const good = await signFileLink({ documentId: id, userId: admin.id, disposition: "attachment" });
    await invalid(`/api/v1/villa-documents/${id}/file?token=${good.slice(0, -2)}xx`);

    const accessToken = await signAccessToken({ id: admin.id, role: admin.role });
    await invalid(`/api/v1/villa-documents/${id}/file?token=${accessToken}`);
  });

  it("a link token is not an access token", async () => {
    const id = await uploadedId();
    const link = await signFileLink({ documentId: id, userId: admin.id, disposition: "attachment" });
    const res = await request(app)
      .get(`/api/v1/villas/${villa.id}/documents`)
      .set("Authorization", `Bearer ${link}`);
    expect(res.status).toBe(401);
  });
});
