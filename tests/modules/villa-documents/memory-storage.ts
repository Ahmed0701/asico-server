import { Readable } from "node:stream";
import type { StorageService } from "../../../src/core/storage/StorageService.js";

const enoent = (): Error => Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

// A StorageService in memory, with switches for the failures a disk can have.
export class MemoryStorage implements StorageService {
  files = new Map<string, Buffer>();
  temps = new Map<string, Buffer>();
  calls: string[] = [];
  failDelete: Error | null = null;
  failDiscard: Error | null = null;
  failDeleteDirectory: Error | null = null;

  receive(name: string, data: Buffer): string {
    const path = `/uploads/.tmp/${name}`;
    this.temps.set(path, data);
    return path;
  }

  async save(_filename: string, data: Buffer): Promise<string> {
    const key = `saved-${this.files.size}`;
    this.files.set(key, data);
    return key;
  }
  async read(key: string): Promise<Buffer> {
    const data = this.files.get(key);
    if (!data) throw enoent();
    return data;
  }
  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
    if (this.failDelete) throw this.failDelete;
    if (!this.files.delete(key)) throw enoent();
  }
  async tempDir(): Promise<string> {
    return "/uploads/.tmp";
  }
  async inspectTemp(tempPath: string, headBytes: number): Promise<{ size: number; head: Buffer }> {
    this.calls.push("inspect");
    const data = this.temps.get(tempPath);
    if (!data) throw enoent();
    return { size: data.length, head: data.subarray(0, headBytes) };
  }
  async moveIn(tempPath: string, key: string): Promise<void> {
    this.calls.push(`move:${key}`);
    const data = this.temps.get(tempPath);
    if (!data) throw enoent();
    this.temps.delete(tempPath);
    this.files.set(key, data);
  }
  async discardTemp(tempPath: string): Promise<void> {
    this.calls.push("discard");
    if (this.failDiscard) throw this.failDiscard;
    this.temps.delete(tempPath);
  }
  async size(key: string): Promise<number> {
    const data = this.files.get(key);
    if (!data) throw enoent();
    return data.length;
  }
  createReadStream(key: string): Readable {
    return Readable.from([this.files.get(key) ?? Buffer.alloc(0)]);
  }
  async deleteDirectory(prefix: string): Promise<void> {
    this.calls.push(`deleteDirectory:${prefix}`);
    if (this.failDeleteDirectory) throw this.failDeleteDirectory;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${prefix}/`)) this.files.delete(key);
    }
  }
}
