import { PASSWORD_RESET_TTL_MINUTES } from "../../../shared/constants/security.js";
import type { AuthRepository, Db } from "../repository/auth.repository.js";
import { generateToken } from "./tokens.js";

const MINUTE_MS = 60_000;

// Issues a password reset token for a user: every earlier unused one is spent, and only the hash of the new one is
// stored. Returns the raw token, which exists nowhere else. Run it inside the caller's transaction.
export async function issueResetToken(
  repository: Pick<AuthRepository, "useAllResetTokens" | "createResetToken">,
  userId: string,
  now: Date,
  tx: Db,
): Promise<string> {
  const reset = generateToken();
  await repository.useAllResetTokens(userId, now, tx);
  await repository.createResetToken(
    {
      userId,
      tokenHash: reset.hash,
      expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * MINUTE_MS),
    },
    tx,
  );
  return reset.token;
}
