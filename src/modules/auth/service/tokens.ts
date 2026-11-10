import { createHash, randomBytes } from "node:crypto";

// Refresh and reset tokens are 256 random bits, so a fast hash is enough: only the hash is stored.
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
