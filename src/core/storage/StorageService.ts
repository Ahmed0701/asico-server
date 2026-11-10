import type { Readable } from "node:stream";

export interface StorageService {
  save(filename: string, data: Buffer): Promise<string>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;

  // Uploads are received into a temporary folder inside the storage root, checked, and only then moved to
  // their final key. The temp folder is on the same filesystem, so the move is an atomic rename.
  tempDir(): Promise<string>;
  moveIn(tempPath: string, key: string): Promise<void>;
  // The size of a received file and its first bytes, read from the temp file itself (never from the client).
  inspectTemp(tempPath: string, headBytes: number): Promise<{ size: number; head: Buffer }>;
  discardTemp(tempPath: string): Promise<void>;

  size(key: string): Promise<number>;
  createReadStream(key: string): Readable;
  // Removes a key prefix ("a folder") and everything below it; a missing folder is not an error.
  deleteDirectory(prefix: string): Promise<void>;
}
