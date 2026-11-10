import { errors, jwtVerify, SignJWT } from "jose";
import type { Role } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";

const ISSUER = "asico-server";
const ALGORITHM = "HS256";
const secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

export class InvalidAccessTokenError extends Error {}
// A token we signed whose lifetime is over: the client should refresh, not sign the user out.
export class ExpiredAccessTokenError extends InvalidAccessTokenError {}

export async function signAccessToken(user: { id: string; role: Role }): Promise<string> {
  return new SignJWT({ role: user.role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(user.id)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${env.JWT_ACCESS_TTL_SECONDS}s`)
    .sign(secret);
}

// The role claim is informational only: the middleware reads the user's current role from the database.
export async function verifyAccessToken(token: string): Promise<{ userId: string }> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, algorithms: [ALGORITHM] });
    if (typeof payload.sub !== "string" || payload.sub === "") {
      throw new InvalidAccessTokenError("missing subject");
    }
    return { userId: payload.sub };
  } catch (err) {
    if (err instanceof InvalidAccessTokenError) {
      throw err;
    }
    // The signature is checked before the expiry, so this is only ever a genuine token that has run out.
    throw err instanceof errors.JWTExpired
      ? new ExpiredAccessTokenError("access token expired")
      : new InvalidAccessTokenError("invalid access token");
  }
}
