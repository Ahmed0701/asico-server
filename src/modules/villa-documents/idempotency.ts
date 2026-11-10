import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import type { Request } from "express";

// What makes one upload "the same request" as another for an Idempotency-Key: the file's name, size and content.
// (The body of a multipart request is not parsed JSON, so the generic request hash has nothing to go on.)
export async function uploadFingerprint(req: Request): Promise<string> {
  const { file } = req;
  if (!file) {
    return "no-file";
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file.path)) {
    digest.update(chunk as Buffer);
  }
  return `${file.originalname}:${file.size}:${digest.digest("hex")}`;
}

// A repeated upload does not run, so the copy it left in the temp folder is removed.
export async function discardUpload(req: Request): Promise<void> {
  if (req.file) {
    await unlink(req.file.path).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") {
        throw err;
      }
    });
  }
}
