import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { env } from "../config/env.js";
import { AppError } from "../errors/AppError.js";
import { t } from "../i18n/index.js";
import type { StorageService } from "./StorageService.js";

const TEMP_FOLDER = ".tmp";

function safeExtension(filename: string): string {
  const extension = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : "";
}

const invalidKey = (): AppError => new AppError(400, t("en", "errors.badRequest"), "INVALID_STORAGE_KEY");

export class LocalDiskStorage implements StorageService {
  private readonly root: string;
  private readonly temp: string;

  constructor(root = env.UPLOAD_DIR) {
    this.root = resolve(root);
    this.temp = resolve(this.root, TEMP_FOLDER);
  }

  async save(filename: string, data: Buffer): Promise<string> {
    const key = `${randomUUID()}${safeExtension(filename)}`;
    await mkdir(this.root, { recursive: true });
    await writeFile(this.pathFor(key), data);
    return key;
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await unlink(this.pathFor(key));
  }

  async tempDir(): Promise<string> {
    await mkdir(this.temp, { recursive: true });
    return this.temp;
  }

  // Only a file directly inside the temp folder may be moved in, whatever path the caller passes.
  async moveIn(tempPath: string, key: string): Promise<void> {
    const source = this.tempPathFor(tempPath);
    const target = this.pathFor(key);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
  }

  async inspectTemp(tempPath: string, headBytes: number): Promise<{ size: number; head: Buffer }> {
    const handle = await open(this.tempPathFor(tempPath), "r");
    try {
      const { size } = await handle.stat();
      const buffer = Buffer.alloc(Math.min(headBytes, size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return { size, head: buffer.subarray(0, bytesRead) };
    } finally {
      await handle.close();
    }
  }

  // Idempotent: a temp file that is already gone (moved, or removed by the upload library) is fine.
  async discardTemp(tempPath: string): Promise<void> {
    await rm(this.tempPathFor(tempPath), { force: true });
  }

  async size(key: string): Promise<number> {
    return (await stat(this.pathFor(key))).size;
  }

  createReadStream(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  async deleteDirectory(prefix: string): Promise<void> {
    await rm(this.pathFor(prefix), { recursive: true, force: true });
  }

  // Keys are relative, inside the root, and never inside the temp folder (that is not addressable as a key).
  private pathFor(key: string): string {
    if (key === "" || key.includes("\0")) {
      throw invalidKey();
    }
    const path = resolve(this.root, key);
    if (!path.startsWith(this.root + sep) || path === this.temp || path.startsWith(this.temp + sep)) {
      throw invalidKey();
    }
    return path;
  }

  private tempPathFor(tempPath: string): string {
    if (tempPath.includes("\0")) {
      throw invalidKey();
    }
    const path = resolve(tempPath);
    if (!path.startsWith(this.temp + sep) || dirname(path) !== this.temp) {
      throw invalidKey();
    }
    return path;
  }
}
