import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../../../src/core/config/env.js";
import { AppError } from "../../../src/core/errors/AppError.js";
import type { Actor, RequestContext } from "../../../src/core/middleware/requestContext.js";
import type {
  Db,
  StoredFileRow,
  VillaDocumentRow,
  VillaDocumentsRepository,
} from "../../../src/modules/villa-documents/repository/villa-documents.repository.js";
import { VillaDocumentsService } from "../../../src/modules/villa-documents/service/villa-documents.service.js";
import { removeVillaDocuments } from "../../../src/modules/villa-documents/service/remove-villa-documents.js";
import { MemoryStorage } from "./memory-storage.js";

vi.mock("../../../src/core/audit/audit.js", async (importActual) => ({
  ...(await importActual<typeof import("../../../src/core/audit/audit.js")>()),
  audit: { record: vi.fn() },
}));
import { audit } from "../../../src/core/audit/audit.js";

const ctx: RequestContext = { locale: "en", ip: "203.0.113.5", userAgent: "vitest", requestId: "req-1" };
const ctxAr: RequestContext = { ...ctx, locale: "ar" };
const actor: Actor = { id: "user-1", role: "EMPLOYEE" };
const tx = { marker: "tx" } as unknown as Db;
const VILLA = "11111111-1111-4111-8111-111111111111";
const KEY_PATTERN = new RegExp(`^villas/${VILLA}/[0-9a-f-]{36}\\.pdf$`);
const PDF = Buffer.from("%PDF-1.7\nhello\n%%EOF");

function documentRow(overrides: Partial<VillaDocumentRow> = {}): VillaDocumentRow {
  return {
    id: "doc-1",
    villaId: VILLA,
    originalName: "plan.pdf",
    sizeBytes: PDF.length,
    mimeType: "application/pdf",
    createdAt: new Date("2026-03-04T05:06:07.890Z"),
    uploadedBy: { id: "user-1", name: "Some Employee" },
    ...overrides,
  };
}

function storedRow(overrides: Partial<StoredFileRow> = {}): StoredFileRow {
  return { ...documentRow(), storageKey: `villas/${VILLA}/abc.pdf`, ...overrides };
}

function makeRepo() {
  return {
    transaction: vi.fn(async (work: (client: Db) => Promise<unknown>) => work(tx)),
    villaExists: vi.fn().mockResolvedValue(true),
    lockVilla: vi.fn().mockResolvedValue(true),
    countDocuments: vi.fn().mockResolvedValue(0),
    createDocument: vi.fn().mockResolvedValue(documentRow()),
    listByVilla: vi.fn().mockResolvedValue([]),
    findStored: vi.fn(),
    deleteDocument: vi.fn(),
  };
}

let repo: ReturnType<typeof makeRepo>;
let storage: MemoryStorage;
let service: VillaDocumentsService;
const auditEntry = (index = 0) => vi.mocked(audit.record).mock.calls[index]?.[1];

async function failure(promise: Promise<unknown>): Promise<AppError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

const limits = { documents: env.MAX_DOCUMENTS_PER_VILLA };

beforeEach(() => {
  vi.mocked(audit.record).mockReset();
  repo = makeRepo();
  storage = new MemoryStorage();
  service = new VillaDocumentsService(repo as unknown as VillaDocumentsRepository, storage);
});

afterEach(() => {
  env.MAX_DOCUMENTS_PER_VILLA = limits.documents;
  vi.restoreAllMocks();
});

const receive = (data: Buffer = PDF, name = "t1.upload") => storage.receive(name, data);
const upload = (tempPath: string, originalName = "plan.pdf", context = ctx) =>
  service.upload(actor, { villaId: VILLA, tempPath, originalName }, context);

describe("assertCanUpload", () => {
  it("passes for a villa that has room", async () => {
    await expect(service.assertCanUpload(VILLA, ctx)).resolves.toBeUndefined();
  });

  it("answers 404 VILLA_NOT_FOUND for an unknown villa, in Arabic", async () => {
    repo.villaExists.mockResolvedValue(false);

    expect(await failure(service.assertCanUpload(VILLA, ctxAr))).toMatchObject({
      statusCode: 404,
      code: "VILLA_NOT_FOUND",
      message: "الفيلا غير موجودة",
    });
  });

  it("answers 409 VILLA_DOCUMENT_LIMIT once the villa has the maximum number of documents", async () => {
    env.MAX_DOCUMENTS_PER_VILLA = 3;
    repo.countDocuments.mockResolvedValue(2);
    await expect(service.assertCanUpload(VILLA, ctx)).resolves.toBeUndefined();

    repo.countDocuments.mockResolvedValue(3);
    expect(await failure(service.assertCanUpload(VILLA, ctxAr))).toMatchObject({
      statusCode: 409,
      code: "VILLA_DOCUMENT_LIMIT",
      message: "وصلت هذه الفيلا إلى الحد الأقصى لعدد المستندات",
    });
  });
});

describe("upload", () => {
  it("checks the file, moves it to a server-made key, then records it in one transaction", async () => {
    const dto = await upload(receive());

    const moved = storage.calls.find((c) => c.startsWith("move:"))?.slice(5) ?? "";
    expect(moved).toMatch(KEY_PATTERN);
    expect(storage.calls.indexOf("inspect")).toBeLessThan(storage.calls.indexOf(`move:${moved}`));
    expect(repo.transaction).toHaveBeenCalledTimes(1);
    expect(repo.lockVilla).toHaveBeenCalledWith(VILLA, tx);
    expect(repo.createDocument).toHaveBeenCalledWith(
      {
        villaId: VILLA,
        storageKey: moved,
        originalName: "plan.pdf",
        sizeBytes: PDF.length,
        mimeType: "application/pdf",
        uploadedById: "user-1",
      },
      tx,
    );
    expect(storage.files.has(moved)).toBe(true);
    expect(storage.temps.size).toBe(0);
    expect(dto).toEqual({
      id: "doc-1",
      villaId: VILLA,
      originalName: "plan.pdf",
      sizeBytes: PDF.length,
      mimeType: "application/pdf",
      uploadedBy: { id: "user-1", name: "Some Employee" },
      createdAt: "2026-03-04T05:06:07.890Z",
    });
  });

  it("takes the stored size from the file itself", async () => {
    await upload(receive(Buffer.concat([PDF, Buffer.alloc(1000)])));

    expect(repo.createDocument.mock.calls[0]?.[0]).toMatchObject({ sizeBytes: PDF.length + 1000 });
  });

  it("audits villa_document.upload in the same transaction, with the stored key", async () => {
    await upload(receive());

    const key = storage.calls.find((c) => c.startsWith("move:"))?.slice(5);
    expect(vi.mocked(audit.record).mock.calls[0]?.[0]).toBe(tx);
    expect(auditEntry()).toEqual({
      actorId: "user-1",
      action: "villa_document.upload",
      entity: "VillaDocument",
      entityId: "doc-1",
      after: {
        id: "doc-1",
        villaId: VILLA,
        originalName: "plan.pdf",
        sizeBytes: PDF.length,
        mimeType: "application/pdf",
        storageKey: key,
      },
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
  });

  it("sanitizes the original name before it is stored", async () => {
    await upload(receive(), "..\\..\\etc/passwd\u0000‮.exe");

    expect(repo.createDocument.mock.calls[0]?.[0]).toMatchObject({ originalName: "passwd.exe.pdf" });
  });

  it.each([
    ["a renamed executable", Buffer.from("MZ\u0090\u0000\u0003\u0000\u0000\u0000")],
    ["plain text", Buffer.from("hello, this is not a pdf")],
    ["an HTML page", Buffer.from("<html><body>%PDF-</body></html>")],
    ["an empty file", Buffer.alloc(0)],
    ["a file shorter than the signature", Buffer.from("%PDF")],
    ["a PDF with a byte before the signature", Buffer.from(" %PDF-1.4\n")],
    ["a lowercase signature", Buffer.from("%pdf-1.4\n")],
  ])(
    "rejects %s with 400 INVALID_FILE_TYPE, stores nothing and leaves no temp file",
    async (_label, data) => {
      const path = receive(data);

      expect(await failure(upload(path))).toMatchObject({ statusCode: 400, code: "INVALID_FILE_TYPE" });

      expect(storage.files.size).toBe(0);
      expect(storage.temps.size).toBe(0);
      expect(repo.transaction).not.toHaveBeenCalled();
      expect(storage.calls.some((c) => c.startsWith("move:"))).toBe(false);
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it("does not trust the original name or an extension: a .pdf name with other content is rejected", async () => {
    expect(await failure(upload(receive(Buffer.from("MZ....")), "invoice.pdf"))).toMatchObject({
      code: "INVALID_FILE_TYPE",
    });
  });

  it("accepts a real PDF whatever its name says", async () => {
    await expect(upload(receive(), "scan.png")).resolves.toBeDefined();
    expect(repo.createDocument.mock.calls[0]?.[0]).toMatchObject({ originalName: "scan.png.pdf" });
  });

  it("answers 404 VILLA_NOT_FOUND when the villa is gone by the time it is locked, and removes the file", async () => {
    repo.lockVilla.mockResolvedValue(false);

    expect(await failure(upload(receive()))).toMatchObject({ statusCode: 404, code: "VILLA_NOT_FOUND" });

    expect(storage.files.size).toBe(0);
    expect(storage.temps.size).toBe(0);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("answers 409 when another upload filled the villa first (checked again under the lock), and removes the file", async () => {
    env.MAX_DOCUMENTS_PER_VILLA = 2;
    repo.countDocuments.mockResolvedValue(2);

    expect(await failure(upload(receive()))).toMatchObject({
      statusCode: 409,
      code: "VILLA_DOCUMENT_LIMIT",
    });

    expect(storage.files.size).toBe(0);
    expect(repo.createDocument).not.toHaveBeenCalled();
  });

  it("deletes the stored file again when the transaction fails, and the original error comes through", async () => {
    const boom = new Error("audit down");
    vi.mocked(audit.record).mockRejectedValue(boom);

    await expect(upload(receive())).rejects.toBe(boom);

    expect(storage.files.size).toBe(0);
    expect(storage.temps.size).toBe(0);
    expect(storage.calls.filter((c) => c.startsWith("delete:"))).toHaveLength(1);
  });

  it("still reports the transaction's error when the cleanup itself fails", async () => {
    const boom = new Error("database down");
    repo.createDocument.mockRejectedValue(boom);
    storage.failDelete = new Error("disk read-only");

    await expect(upload(receive())).rejects.toBe(boom);
  });

  it("does not fail an upload that succeeded because the temp cleanup failed", async () => {
    storage.failDiscard = new Error("disk read-only");

    await expect(upload(receive())).resolves.toBeDefined();
  });

  it("removes the temp file even when it cannot be read", async () => {
    const path = receive();
    storage.temps.delete(path);

    await expect(upload(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(storage.calls).toContain("discard");
  });
});

describe("remove", () => {
  const remove = (context = ctx) => service.remove(actor, "doc-1", context);
  const key = `villas/${VILLA}/abc.pdf`;

  beforeEach(() => {
    repo.findStored.mockResolvedValue(storedRow());
    storage.files.set(key, PDF);
  });

  it("answers 404 FILE_NOT_FOUND for an unknown document, in the request language, and touches nothing", async () => {
    repo.findStored.mockResolvedValue(null);

    expect(await failure(remove())).toMatchObject({
      statusCode: 404,
      code: "FILE_NOT_FOUND",
      message: "File not found",
    });
    expect(await failure(remove(ctxAr))).toMatchObject({ message: "الملف غير موجود" });
    expect(repo.deleteDocument).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
    expect(storage.files.has(key)).toBe(true);
  });

  it("deletes the row and audits it in the same transaction", async () => {
    const order: string[] = [];
    repo.deleteDocument.mockImplementation(async () => void order.push("delete"));
    vi.mocked(audit.record).mockImplementation(async () => void order.push("audit"));

    await remove();

    expect(order).toEqual(["delete", "audit"]);
    expect(repo.deleteDocument).toHaveBeenCalledWith("doc-1", tx);
  });

  it("audits villa_document.delete with the before snapshot (including the stored key) and no after", async () => {
    await remove();

    expect(vi.mocked(audit.record).mock.calls[0]?.[0]).toBe(tx);
    expect(auditEntry()).toEqual({
      actorId: "user-1",
      action: "villa_document.delete",
      entity: "VillaDocument",
      entityId: "doc-1",
      before: {
        id: "doc-1",
        villaId: VILLA,
        originalName: "plan.pdf",
        sizeBytes: PDF.length,
        mimeType: "application/pdf",
        storageKey: key,
      },
      ip: "203.0.113.5",
      userAgent: "vitest",
      requestId: "req-1",
    });
  });

  it("removes the file from disk only after the transaction has committed", async () => {
    const order: string[] = [];
    repo.transaction.mockImplementation(async (work: (client: Db) => Promise<unknown>) => {
      const result = await work(tx);
      order.push("committed");
      return result;
    });
    storage.delete = async (k: string) => {
      order.push(`disk:${k}`);
      storage.files.delete(k);
    };

    await remove();

    expect(order).toEqual(["committed", `disk:${key}`]);
  });

  it("succeeds when the disk removal fails (the file is left behind as an orphan)", async () => {
    storage.failDelete = Object.assign(new Error("EACCES"), { code: "EACCES" });

    await expect(remove()).resolves.toBeUndefined();

    expect(repo.deleteDocument).toHaveBeenCalled();
    expect(storage.files.has(key)).toBe(true);
  });

  it("succeeds when the file is already gone from disk", async () => {
    storage.files.delete(key);

    await expect(remove()).resolves.toBeUndefined();
  });

  it("leaves the disk alone when the transaction fails", async () => {
    vi.mocked(audit.record).mockRejectedValue(new Error("audit down"));

    await expect(remove()).rejects.toThrow("audit down");

    expect(storage.files.has(key)).toBe(true);
    expect(storage.calls.some((c) => c.startsWith("delete:"))).toBe(false);
  });

  it("answers 404 when another request deleted the row first (P2025), and leaves the disk alone", async () => {
    repo.deleteDocument.mockRejectedValue(Object.assign(new Error("Prisma P2025"), { code: "P2025" }));

    expect(await failure(remove())).toMatchObject({ statusCode: 404, code: "FILE_NOT_FOUND" });
    expect(storage.files.has(key)).toBe(true);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe("downloads and lists", () => {
  it("getForDownload returns the key and the original name, or 404", async () => {
    repo.findStored.mockResolvedValue(storedRow({ originalName: "تقرير.pdf" }));
    await expect(service.getForDownload("doc-1", ctx)).resolves.toEqual({
      storageKey: `villas/${VILLA}/abc.pdf`,
      originalName: "تقرير.pdf",
    });

    repo.findStored.mockResolvedValue(null);
    expect(await failure(service.getForDownload("nope", ctxAr))).toMatchObject({
      statusCode: 404,
      code: "FILE_NOT_FOUND",
    });
  });

  it("openForDownload answers 404 when the row exists but the file is missing from disk", async () => {
    expect(await failure(service.openForDownload("villas/x/missing.pdf", ctx))).toMatchObject({
      statusCode: 404,
      code: "FILE_NOT_FOUND",
    });
  });

  it("openForDownload returns the stream and the size of a stored file", async () => {
    storage.files.set("k.pdf", PDF);

    const { stream, size } = await service.openForDownload("k.pdf", ctx);

    expect(size).toBe(PDF.length);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(PDF);
  });

  it("lists a villa's documents, or answers 404 for an unknown villa", async () => {
    repo.listByVilla.mockResolvedValue([documentRow(), documentRow({ id: "doc-2" })]);
    expect((await service.listByVilla(VILLA, ctx)).map((f) => f.id)).toEqual(["doc-1", "doc-2"]);

    repo.villaExists.mockResolvedValue(false);
    expect(await failure(service.listByVilla(VILLA, ctx))).toMatchObject({ code: "VILLA_NOT_FOUND" });
  });
});

describe("removeVillaDocuments", () => {
  it("deletes the villa's folder", async () => {
    storage.files.set(`villas/${VILLA}/a.pdf`, PDF);
    storage.files.set(`villas/${VILLA}/b.pdf`, PDF);
    storage.files.set("villas/other/c.pdf", PDF);

    await removeVillaDocuments(VILLA, storage);

    expect(storage.calls).toEqual([`deleteDirectory:villas/${VILLA}`]);
    expect([...storage.files.keys()]).toEqual(["villas/other/c.pdf"]);
  });

  it("never throws: a disk failure is only logged", async () => {
    storage.failDeleteDirectory = new Error("EBUSY");

    await expect(removeVillaDocuments(VILLA, storage)).resolves.toBeUndefined();
  });

  it.each(["", "..", "../x", "villas", "a/b", "not-a-uuid", `${VILLA}/..`])(
    "does nothing for %j, which is not a villa id",
    async (id) => {
      await removeVillaDocuments(id, storage);

      expect(storage.calls).toEqual([]);
    },
  );
});
