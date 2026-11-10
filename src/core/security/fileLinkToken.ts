import { createHmac } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";

// A short-lived link to ONE villa document, for a browser to open by itself (a download, or a new tab to view it), where no
// Authorization header can be sent. Download managers and some extensions take over a PDF the page fetches itself and leave the
// page an empty body; a plain link is handled by the browser like any file.
//
// The key is derived from JWT_ACCESS_SECRET but is NOT that secret, so a link token is never accepted as an access token and an
// access token is never accepted as a link.

const ISSUER = "asico-server";
const AUDIENCE = "villa-document-link";
const ALGORITHM = "HS256";
// Long enough for the browser to start the request, short enough that a copied link is soon useless.
export const FILE_LINK_TTL_SECONDS = 60;

export type FileDisposition = "attachment" | "inline";
export type FileLinkClaims = { documentId: string; userId: string; disposition: FileDisposition };

export class InvalidFileLinkError extends Error {}

const key = (): Uint8Array =>
  new Uint8Array(createHmac("sha256", env.JWT_ACCESS_SECRET).update("villa-document-link/v1").digest());

export async function signFileLink(claims: FileLinkClaims, now: Date = new Date()): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  return new SignJWT({ doc: claims.documentId, disp: claims.disposition })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + FILE_LINK_TTL_SECONDS)
    .sign(key());
}

export async function verifyFileLink(token: string): Promise<FileLinkClaims> {
  try {
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: [ALGORITHM],
    });
    const { sub, doc, disp } = payload;
    if (
      typeof sub !== "string" ||
      sub === "" ||
      typeof doc !== "string" ||
      (disp !== "attachment" && disp !== "inline")
    ) {
      throw new InvalidFileLinkError("malformed link");
    }
    return { documentId: doc, userId: sub, disposition: disp };
  } catch (err) {
    throw err instanceof InvalidFileLinkError ? err : new InvalidFileLinkError("invalid or expired link");
  }
}
