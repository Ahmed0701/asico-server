import bcrypt from "bcrypt";
import { audit, type AuditEntry } from "../../../core/audit/audit.js";
import { env } from "../../../core/config/env.js";
import { logger } from "../../../core/config/logger.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import { sendResetEmail, type Mailer } from "../../../core/mail/index.js";
import { signAccessToken } from "../../../core/security/jwt.js";
import type { User } from "../../../generated/prisma/client.js";
import { PERMISSION_CODES } from "../../../shared/constants/permissions.js";
import { BCRYPT_COST, PASSWORD_RESET_COOLDOWN_MS } from "../../../shared/constants/security.js";
import type {
  LoginResult,
  MeDto,
  RefreshCookie,
  RefreshResult,
  RequestContext,
  UserDto,
} from "../dto/auth.dto.js";
import { toMeDto, toUserDto } from "../mapper/auth.mapper.js";
import { AuthRepository, isUniqueViolation } from "../repository/auth.repository.js";
import type {
  ChangePasswordInput,
  ForgotPasswordInput,
  LoginInput,
  ResetPasswordInput,
  SignupInput,
  UpdateMeInput,
} from "../validators/auth.validators.js";
import { issueResetToken } from "./resetTokens.js";
import { generateToken, hashToken } from "./tokens.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// A token spent by a refresh can be presented again for this long without it being taken for theft: long enough
// for the response that carries the new cookie to reach the browser and for a retry to follow.
export const REFRESH_GRACE_MS = 20_000;

// Compared against when the email is unknown, so a miss costs the same time as a wrong password.
const DUMMY_PASSWORD_HASH = "$2b$12$EQ7govgS8cwosRfc6WRoRu72c2l7CYIozSu2fzKL7Ip5kti1TSvia";

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

type AuditFields = Pick<AuditEntry, "actorId" | "action" | "entityId" | "before" | "after">;

function auditEntry(ctx: RequestContext, fields: AuditFields): AuditEntry {
  return { entity: "User", ...fields, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId };
}

export class AuthService {
  constructor(
    private readonly repository = new AuthRepository(),
    private readonly now: () => Date = () => new Date(),
    // Left unset, the configured mailer is looked up when a mail is sent.
    private readonly mailer?: Mailer,
  ) {}

  async signup(input: SignupInput, ctx: RequestContext): Promise<UserDto> {
    if (await this.repository.findUserByEmail(input.email)) {
      throw fail(ctx, 409, "errors.emailTaken", "EMAIL_TAKEN");
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

    try {
      const user = await this.repository.transaction(async (tx) => {
        const created = await this.repository.createUser(
          { name: input.name, email: input.email, passwordHash },
          tx,
        );
        await audit.record(
          tx,
          auditEntry(ctx, {
            actorId: created.id,
            action: "auth.signup",
            entityId: created.id,
            after: {
              name: created.name,
              email: created.email,
              role: created.role,
              isActive: created.isActive,
            },
          }),
        );
        return created;
      });
      return toUserDto(user);
    } catch (err) {
      // Two signups with the same email can both pass the check above; the unique index decides.
      if (isUniqueViolation(err)) {
        throw fail(ctx, 409, "errors.emailTaken", "EMAIL_TAKEN");
      }
      throw err;
    }
  }

  async login(input: LoginInput, ctx: RequestContext): Promise<LoginResult> {
    const user = await this.repository.findUserByEmail(input.email);
    const passwordMatches = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!user || !passwordMatches) {
      throw fail(ctx, 401, "errors.invalidCredentials", "INVALID_CREDENTIALS");
    }
    // Only reveal the account state to someone who proved they know the password.
    if (!user.isActive) {
      throw fail(ctx, 403, "errors.accountInactive", "ACCOUNT_INACTIVE");
    }

    const refresh = this.newRefreshToken(this.now());
    await this.repository.transaction(async (tx) => {
      await this.repository.createRefreshToken(
        { userId: user.id, tokenHash: refresh.hash, expiresAt: refresh.expiresAt },
        tx,
      );
      await audit.record(tx, auditEntry(ctx, { actorId: user.id, action: "auth.login", entityId: user.id }));
    });

    return {
      body: {
        accessToken: await signAccessToken(user),
        expiresIn: env.JWT_ACCESS_TTL_SECONDS,
        user: toUserDto(user),
      },
      refresh: { token: refresh.token, expiresAt: refresh.expiresAt },
    };
  }

  async refresh(rawToken: string | undefined, ctx: RequestContext): Promise<RefreshResult> {
    const invalid = (): AppError => fail(ctx, 401, "errors.invalidRefreshToken", "INVALID_REFRESH_TOKEN");
    if (!rawToken) {
      throw invalid();
    }

    const now = this.now();
    const record = await this.repository.findRefreshTokenByHash(hashToken(rawToken));
    if (!record) {
      throw invalid();
    }
    if (record.revokedAt) {
      // Spent by a refresh a moment ago: the client that won the race holds the new token, and this request is
      // the loser (two tabs, a double fetch). Nothing is revoked and nothing is issued; the client retries.
      if (record.replacedById !== null && now.getTime() - record.revokedAt.getTime() < REFRESH_GRACE_MS) {
        logger.info({ userId: record.userId }, "refresh token presented again just after its rotation");
        throw this.conflict(ctx);
      }
      return this.rejectReuse(record.userId, now, ctx);
    }
    if (record.expiresAt <= now) {
      throw invalid();
    }
    if (!record.user.isActive) {
      await this.repository.revokeUserRefreshTokens(record.userId, now);
      throw fail(ctx, 403, "errors.accountInactive", "ACCOUNT_INACTIVE");
    }

    const next = this.newRefreshToken(now);
    const rotated = await this.repository.transaction((tx) =>
      this.repository.rotateRefreshToken(
        record.id,
        now,
        { userId: record.userId, tokenHash: next.hash, expiresAt: next.expiresAt },
        tx,
      ),
    );
    if (!rotated) {
      // A concurrent request spent this token between the read above and now. It is the same case as a token
      // presented a moment after its rotation, so it gets the same answer: nothing is revoked.
      logger.warn(
        { userId: record.userId },
        "refresh lost a race for the same token; the client should retry",
      );
      throw this.conflict(ctx);
    }

    return {
      body: {
        accessToken: await signAccessToken(record.user),
        expiresIn: env.JWT_ACCESS_TTL_SECONDS,
      },
      refresh: { token: next.token, expiresAt: next.expiresAt },
    };
  }

  async logout(rawToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (!rawToken) {
      return;
    }
    const record = await this.repository.findRefreshTokenByHash(hashToken(rawToken));
    if (!record || record.revokedAt) {
      return;
    }

    await this.repository.transaction(async (tx) => {
      await this.repository.revokeRefreshToken(record.id, this.now(), tx);
      await audit.record(
        tx,
        auditEntry(ctx, { actorId: record.userId, action: "auth.logout", entityId: record.userId }),
      );
    });
  }

  async forgotPassword(input: ForgotPasswordInput, ctx: RequestContext): Promise<void> {
    const user = await this.repository.findUserByEmail(input.email);
    if (!user) {
      return;
    }

    const now = this.now();
    // One reset email a minute per user: the endpoint is limited per address, not per person, so without this one
    // user could be flooded (and the mail account's daily allowance used up) from many addresses. The answer to the
    // caller is the same either way.
    const last = await this.repository.latestOpenResetTokenAt(user.id, now);
    if (last && now.getTime() - last.getTime() < PASSWORD_RESET_COOLDOWN_MS) {
      return;
    }

    const token = await this.repository.transaction((tx) =>
      issueResetToken(this.repository, user.id, now, tx),
    );

    // After the commit, and not waited for: the answer takes the same time for a known and an unknown address, and a
    // slow mail server never holds the request. sendResetEmail does not throw; a failure is logged there.
    void sendResetEmail(
      { to: user.email, name: user.name, locale: ctx.locale, token, reason: "requested" },
      this.mailer,
    );
  }

  async resetPassword(input: ResetPasswordInput, ctx: RequestContext): Promise<void> {
    const invalid = (): AppError => fail(ctx, 400, "errors.invalidResetToken", "INVALID_RESET_TOKEN");
    const now = this.now();
    const record = await this.repository.findResetTokenByHash(hashToken(input.token));
    if (!record || record.usedAt || record.expiresAt <= now) {
      throw invalid();
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

    const done = await this.repository.transaction(async (tx) => {
      if (!(await this.repository.useResetToken(record.id, now, tx))) {
        return false;
      }
      await this.repository.useAllResetTokens(record.userId, now, tx);
      await this.repository.updateUserPassword(record.userId, passwordHash, tx);
      await this.repository.revokeUserRefreshTokens(record.userId, now, {}, tx);
      await audit.record(
        tx,
        auditEntry(ctx, { actorId: record.userId, action: "auth.password_reset", entityId: record.userId }),
      );
      return true;
    });
    if (!done) {
      throw invalid();
    }
  }

  async changePassword(
    userId: string,
    currentRefreshToken: string | undefined,
    input: ChangePasswordInput,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.requireUser(userId, ctx);
    if (!(await bcrypt.compare(input.currentPassword, user.passwordHash))) {
      throw fail(ctx, 400, "errors.invalidCurrentPassword", "INVALID_CURRENT_PASSWORD");
    }
    const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_COST);

    // The session making this request stays signed in; every other one is revoked.
    const current = currentRefreshToken
      ? await this.repository.findRefreshTokenByHash(hashToken(currentRefreshToken))
      : null;
    const exceptId = current?.userId === userId ? current.id : undefined;

    await this.repository.transaction(async (tx) => {
      await this.repository.updateUserPassword(userId, passwordHash, tx);
      await this.repository.revokeUserRefreshTokens(userId, this.now(), { exceptId }, tx);
      await audit.record(
        tx,
        auditEntry(ctx, { actorId: userId, action: "auth.password_changed", entityId: userId }),
      );
    });
  }

  async getMe(userId: string, ctx: RequestContext): Promise<MeDto> {
    const user = await this.requireUser(userId, ctx);
    // ADMIN permissions are implied by the role, so no rows exist for them.
    const permissions =
      user.role === "ADMIN" ? [...PERMISSION_CODES] : await this.repository.getPermissionCodes(userId);
    return toMeDto(user, permissions);
  }

  async updateMe(userId: string, input: UpdateMeInput, ctx: RequestContext): Promise<MeDto> {
    const previousName = (await this.requireUser(userId, ctx)).name;
    const updated = await this.repository.transaction(async (tx) => {
      const user = await this.repository.updateUserName(userId, input.name, tx);
      await audit.record(
        tx,
        auditEntry(ctx, {
          actorId: userId,
          action: "user.profile_updated",
          entityId: userId,
          before: { name: previousName },
          after: { name: user.name },
        }),
      );
      return user;
    });
    const permissions =
      updated.role === "ADMIN" ? [...PERMISSION_CODES] : await this.repository.getPermissionCodes(userId);
    return toMeDto(updated, permissions);
  }

  private newRefreshToken(now: Date): RefreshCookie & { hash: string } {
    const { token, hash } = generateToken();
    return { token, hash, expiresAt: new Date(now.getTime() + env.REFRESH_TOKEN_TTL_DAYS * DAY_MS) };
  }

  private async requireUser(userId: string, ctx: RequestContext): Promise<User> {
    const user = await this.repository.findUserById(userId);
    if (!user) {
      throw fail(ctx, 401, "errors.unauthorized", "UNAUTHORIZED");
    }
    return user;
  }

  // 409, not 401: the session is fine. The client waits a moment and sends the cookie it holds by then.
  private conflict(ctx: RequestContext): AppError {
    return fail(ctx, 409, "errors.refreshConflict", "REFRESH_CONFLICT");
  }

  // A revoked token showing up again, after the grace window, means it was copied. Sign the user out everywhere.
  private async rejectReuse(userId: string, now: Date, ctx: RequestContext): Promise<never> {
    await this.repository.revokeUserRefreshTokens(userId, now);
    logger.warn({ userId }, "refresh token reuse detected; all refresh tokens revoked");
    throw fail(ctx, 401, "errors.refreshTokenReused", "REFRESH_TOKEN_REUSED");
  }
}
