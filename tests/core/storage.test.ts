import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDiskStorage } from "../../src/core/storage/LocalDiskStorage.js";

describe("LocalDiskStorage", () => {
  let root: string;
  let storage: LocalDiskStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "asico-storage-"));
    storage = new LocalDiskStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("round-trips data under a generated key that keeps a safe extension", async () => {
    const key = await storage.save("../../evil name.PDF", Buffer.from("hello"));

    expect(key).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    await expect(storage.read(key)).resolves.toEqual(Buffer.from("hello"));
    await storage.delete(key);
    await expect(storage.read(key)).rejects.toThrow();
  });

  it("rejects keys that escape the root", async () => {
    await expect(storage.read("../outside.txt")).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY" });
    await expect(storage.delete("../../outside.txt")).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY" });
  });
});

describe("LocalDiskStorage uploads", () => {
  let base: string;
  let root: string;
  let storage: LocalDiskStorage;

  const tempFile = async (name: string, data: Buffer | string): Promise<string> => {
    const path = join(await storage.tempDir(), name);
    await writeFile(path, data);
    return path;
  };

  beforeEach(async () => {
    // An outer folder, so a path that escapes the root can be seen landing somewhere harmless and checked.
    base = await mkdtemp(join(tmpdir(), "asico-uploads-"));
    root = join(base, "root");
    await mkdir(root);
    storage = new LocalDiskStorage(root);
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  // Backslashes and drive letters are path syntax on Windows only; on Linux they are ordinary file name
  // characters and the key stays inside the root, so those keys are listed for Windows only.
  const windowsOnly =
    process.platform === "win32"
      ? ["C:\\Windows\\win.ini", "\\\\server\\share\\x.pdf", "..\\outside.pdf"]
      : [];
  const hostileKeys = [
    "../outside.pdf",
    "../../outside.pdf",
    "villas/../../outside.pdf",
    "villas/x/../../../outside.pdf",
    "/etc/passwd",
    ...windowsOnly,
    "",
    ".",
    "..",
    "villas\0.pdf",
    ".tmp",
    ".tmp/x.upload",
    "villas/../.tmp/x.upload",
  ];

  it("tempDir creates the temp folder inside the root", async () => {
    const dir = await storage.tempDir();

    expect(dir).toBe(join(root, ".tmp"));
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("moveIn puts a received file at its key, creating folders, and the temp file is gone", async () => {
    const source = await tempFile("a.upload", "%PDF-1.4 content");

    await storage.moveIn(source, "villas/p1/f1.pdf");

    await expect(storage.read("villas/p1/f1.pdf")).resolves.toEqual(Buffer.from("%PDF-1.4 content"));
    await expect(stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storage.size("villas/p1/f1.pdf")).resolves.toBe(16);
  });

  it("createReadStream streams a stored file", async () => {
    await storage.moveIn(await tempFile("a.upload", "hello pdf"), "villas/p1/f1.pdf");

    const chunks: Buffer[] = [];
    for await (const chunk of storage.createReadStream("villas/p1/f1.pdf")) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString()).toBe("hello pdf");
  });

  it("inspectTemp returns the size and the first bytes, never more than asked", async () => {
    const path = await tempFile("a.upload", "%PDF-1.4 and a lot more");

    const result = await storage.inspectTemp(path, 5);

    expect(result.size).toBe(23);
    expect(result.head.toString()).toBe("%PDF-");
    expect((await storage.inspectTemp(await tempFile("b.upload", "ab"), 5)).head.toString()).toBe("ab");
    expect((await storage.inspectTemp(await tempFile("c.upload", ""), 5)).head).toHaveLength(0);
  });

  it("discardTemp removes a temp file, and removing it twice is fine", async () => {
    const path = await tempFile("a.upload", "x");

    await storage.discardTemp(path);
    await storage.discardTemp(path);

    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deleteDirectory removes a folder and everything under it, and a missing folder is fine", async () => {
    await storage.moveIn(await tempFile("a.upload", "1"), "villas/p1/a.pdf");
    await storage.moveIn(await tempFile("b.upload", "2"), "villas/p1/sub/b.pdf");
    await storage.moveIn(await tempFile("c.upload", "3"), "villas/p2/c.pdf");

    await storage.deleteDirectory("villas/p1");
    await storage.deleteDirectory("villas/never-existed");

    await expect(storage.read("villas/p1/a.pdf")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storage.read("villas/p2/c.pdf")).resolves.toEqual(Buffer.from("3"));
  });

  describe.each(hostileKeys)("hostile storage key %j", (key) => {
    it("is refused by every operation that takes a key, and nothing outside the root is touched", async () => {
      await writeFile(join(base, "outside.pdf"), "keep me");
      await writeFile(join(base, "root", "inside.pdf"), "keep me too");
      const source = await tempFile("a.upload", "x");
      const operations: [string, () => Promise<unknown>][] = [
        ["read", () => storage.read(key)],
        ["delete", () => storage.delete(key)],
        ["size", () => storage.size(key)],
        ["deleteDirectory", () => storage.deleteDirectory(key)],
        ["moveIn", () => storage.moveIn(source, key)],
        ["createReadStream", async () => storage.createReadStream(key)],
      ];

      for (const [name, run] of operations) {
        await expect(run(), name).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY" });
      }

      await expect(readFile(join(base, "outside.pdf"), "utf8")).resolves.toBe("keep me");
      await expect(readFile(join(root, "inside.pdf"), "utf8")).resolves.toBe("keep me too");
      await expect(stat(source)).resolves.toBeDefined();
    });
  });

  describe("a temp path that is not a received file", () => {
    it.each([
      ["a file in the storage root", () => join(root, "inside.pdf")],
      ["a file outside the root", () => join(base, "outside.pdf")],
      ["a path that climbs out of the temp folder", () => join(root, ".tmp", "..", "inside.pdf")],
      ["a file in a sub-folder of the temp folder", () => join(root, ".tmp", "sub", "a.upload")],
      ["the temp folder itself", () => join(root, ".tmp")],
      ["a relative path", () => "inside.pdf"],
      ["a path with a null byte", () => join(root, ".tmp", "a\0.upload")],
    ])("is refused by moveIn, inspectTemp and discardTemp: %s", async (_label, path) => {
      await writeFile(join(base, "outside.pdf"), "keep me");
      await writeFile(join(root, "inside.pdf"), "keep me too");
      const target = path();

      await expect(storage.moveIn(target, "villas/p1/x.pdf")).rejects.toMatchObject({
        code: "INVALID_STORAGE_KEY",
      });
      await expect(storage.inspectTemp(target, 5)).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY" });
      await expect(storage.discardTemp(target)).rejects.toMatchObject({ code: "INVALID_STORAGE_KEY" });

      await expect(readFile(join(base, "outside.pdf"), "utf8")).resolves.toBe("keep me");
      await expect(readFile(join(root, "inside.pdf"), "utf8")).resolves.toBe("keep me too");
    });
  });
});
