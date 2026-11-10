import bcrypt from "bcrypt";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import { sendResetEmail, type Mailer } from "../../../core/mail/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import type { User } from "../../../generated/prisma/client.js";
import { PERMISSION_CODES, PERMISSIONS } from "../../../shared/constants/permissions.js";
import { BCRYPT_COST } from "../../../shared/constants/security.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { toMeDto, toUserDto } from "../../auth/mapper/auth.mapper.js";
import { AuthRepository, isUniqueViolation } from "../../auth/repository/auth.repository.js";
import { issueResetToken } from "../../auth/service/resetTokens.js";
import { isForeignKeyViolation } from "../../../shared/utils/index.js";
import { PermissionsRepository } from "../../permissions/repository/permissions.repository.js";
import {
  isUserSortField,
  USER_SORT_FIELDS,
  type MeDto,
  type UserDto,
  type UserListResult,
  type UserSort,
} from "../dto/users.dto.js";
import { UsersRepository, type Db } from "../repository/users.repository.js";
import type { CreateUserInput, ListUsersQuery, UpdateUserInput } from "../validators/users.validators.js";

const DEFAULT_SORT: UserSort = { field: "createdAt", direction: "desc" };

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

export class UsersService {
  constructor(
    private readonly repository = new UsersRepository(),
    private readonly permissions = new PermissionsRepository(),
    private readonly now: () => Date = () => new Date(),
    private readonly resets: Pick<
      AuthRepository,
      "useAllResetTokens" | "createResetToken"
    > = new AuthRepository(),
    // Left unset, the configured mailer is looked up when a mail is sent.
    private readonly mailer?: Mailer,
  ) {}

  async list(query: ListUsersQuery): Promise<UserListResult> {
    const requested = parseSort(query.sort, USER_SORT_FIELDS);
    const sort: UserSort =
      requested && isUserSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { users, total } = await this.repository.list({
      filters: { role: query.role, isActive: query.isActive, search: query.search },
      sort,
      skip,
      take,
    });
    return { users: users.map(toUserDto), meta: buildMeta(page, limit, total) };
  }

  async get(id: string, ctx: RequestContext): Promise<MeDto> {
    const user = await this.requireUser(id, ctx);
    return toMeDto(user, await this.codesOf(user));
  }

  async create(actor: Actor, input: CreateUserInput, ctx: RequestContext): Promise<MeDto> {
    // users:create alone must not be a way around permissions:assign: the new user's password is chosen by the caller.
    if (input.permissions.length > 0 && !(await this.mayAssignPermissions(actor))) {
      throw fail(ctx, 403, "errors.forbidden", "PERMISSION_ASSIGN_REQUIRED");
    }
    if (await this.repository.findByEmail(input.email)) {
      throw fail(ctx, 409, "errors.emailTaken", "EMAIL_TAKEN");
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

    try {
      const { user, codes } = await this.repository.transaction(async (tx) => {
        const created = await this.repository.createUser(
          { name: input.name, email: input.email, passwordHash, isActive: input.isActive },
          tx,
        );
        const { after } = await this.permissions.setUserCodes(created.id, input.permissions, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "user.create",
            entity: "User",
            entityId: created.id,
            after: {
              name: created.name,
              email: created.email,
              role: created.role,
              isActive: created.isActive,
              permissions: after,
            },
          }),
        );
        return { user: created, codes: after };
      });
      return toMeDto(user, codes);
    } catch (err) {
      // Two requests with the same email can both pass the check above; the unique index decides.
      if (isUniqueViolation(err)) {
        throw fail(ctx, 409, "errors.emailTaken", "EMAIL_TAKEN");
      }
      throw err;
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateUserInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<UserDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        // Otherwise anyone with users:update could point the administrator's email at themselves.
        if (target.role === "ADMIN" && actor.role !== "ADMIN") {
          throw fail(ctx, 403, "errors.adminAccountProtected", "ADMIN_ACCOUNT_PROTECTED");
        }
        if (
          input.email !== undefined &&
          input.email !== target.email &&
          (await this.repository.findByEmail(input.email, tx))
        ) {
          throw fail(ctx, 409, "errors.emailTaken", "EMAIL_TAKEN");
        }

        const before = { name: target.name, email: target.email };
        const user = await this.repository.updateUser(
          id,
          target.version,
          {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.email !== undefined && { email: input.email }),
          },
          tx,
        );
        if (!user) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "user.update",
            entity: "User",
            entityId: id,
            before,
            after: { name: user.name, email: user.email },
          }),
        );
        return user;
      });
      return toUserDto(updated);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw fail(ctx, 409, "errors.emailTaken", "EMAIL_TAKEN");
      }
      throw err;
    }
  }

  async activate(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<UserDto> {
    const updated = await this.repository.transaction(async (tx) => {
      const target = await this.lock(id, expectedVersion, ctx, tx);
      const user = await this.repository.setActive(id, target.version, true, tx);
      if (!user) {
        throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
      }
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "user.activate",
          entity: "User",
          entityId: id,
          before: { isActive: target.isActive },
          after: { isActive: true },
        }),
      );
      return user;
    });
    return toUserDto(updated);
  }

  async deactivate(
    actor: Actor,
    id: string,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<UserDto> {
    const updated = await this.repository.transaction(async (tx) => {
      const target = await this.lock(id, expectedVersion, ctx, tx);
      if (target.role === "ADMIN") {
        throw fail(ctx, 403, "errors.adminCannotBeDeactivated", "ADMIN_CANNOT_BE_DEACTIVATED");
      }
      if (target.id === actor.id) {
        throw fail(ctx, 403, "errors.cannotDeactivateSelf", "CANNOT_DEACTIVATE_SELF");
      }
      const user = await this.repository.setActive(id, target.version, false, tx);
      if (!user) {
        throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
      }
      // Same transaction: a deactivated user must never be left holding a working session.
      await this.repository.revokeUserRefreshTokens(id, this.now(), tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "user.deactivate",
          entity: "User",
          entityId: id,
          before: { isActive: target.isActive },
          after: { isActive: false },
        }),
      );
      return user;
    });
    return toUserDto(updated);
  }

  // Deletes a user for good. Not an ADMIN, not yourself, and not someone whose name villas or villa documents carry as their
  // author: deactivate them instead, which keeps the history.
  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (target.role === "ADMIN") {
          throw fail(ctx, 403, "errors.adminCannotBeDeleted", "ADMIN_CANNOT_BE_DELETED");
        }
        if (target.id === actor.id) {
          throw fail(ctx, 403, "errors.cannotDeleteSelf", "CANNOT_DELETE_SELF");
        }
        if ((await this.repository.countAuthoredRecords(id, tx)) > 0) {
          throw fail(ctx, 409, "errors.userHasRecords", "USER_HAS_RECORDS");
        }
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "user.delete",
            entity: "User",
            entityId: id,
            before: { name: target.name, email: target.email, role: target.role, isActive: target.isActive },
          }),
        );
      });
    } catch (err) {
      // A villa or document was added for them after the count: the foreign key still keeps them.
      if (isForeignKeyViolation(err)) throw fail(ctx, 409, "errors.userHasRecords", "USER_HAS_RECORDS");
      throw err;
    }
  }

  // The administrator's way to get someone back in without ever seeing or choosing a password: the user gets a reset
  // link by email and every session they have is signed out. The link itself is not in the response, the audit row
  // or the log.
  async resetPassword(actor: Actor, id: string, ctx: RequestContext): Promise<void> {
    const target = await this.requireUser(id, ctx);
    // Otherwise anyone with users:update could take over the administrator's account by resetting its password.
    if (target.role === "ADMIN" && actor.role !== "ADMIN") {
      throw fail(ctx, 403, "errors.adminAccountProtected", "ADMIN_ACCOUNT_PROTECTED");
    }

    const now = this.now();
    const token = await this.repository.transaction(async (tx) => {
      const issued = await issueResetToken(this.resets, id, now, tx);
      await this.repository.revokeUserRefreshTokens(id, now, tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "user.password_reset_issued",
          entity: "User",
          entityId: id,
          after: { sessionsRevoked: true },
        }),
      );
      return issued;
    });

    // Waited for, unlike the public forgot-password: the administrator needs to know if it did not go out.
    const sent = await sendResetEmail(
      { to: target.email, name: target.name, locale: ctx.locale, token, reason: "admin" },
      this.mailer,
    );
    if (!sent) {
      throw fail(ctx, 502, "errors.emailDeliveryFailed", "EMAIL_DELIVERY_FAILED");
    }
  }

  private async mayAssignPermissions(actor: Actor): Promise<boolean> {
    if (actor.role === "ADMIN") {
      return true;
    }
    return (await this.permissions.getUserCodes(actor.id)).includes(PERMISSIONS.PERMISSIONS_ASSIGN);
  }

  // Locks the user for this transaction, refuses a version the caller did not read, and returns the row as it is now:
  // what the audit entry records as "before" is exactly what this write replaces.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<User> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) {
      throw fail(ctx, 404, "errors.userNotFound", "USER_NOT_FOUND");
    }
    assertVersion(ctx.locale, expectedVersion, version);
    const user = await this.repository.findById(id, tx);
    if (!user) {
      throw fail(ctx, 404, "errors.userNotFound", "USER_NOT_FOUND");
    }
    return user;
  }

  private async requireUser(id: string, ctx: RequestContext): Promise<User> {
    const user = await this.repository.findById(id);
    if (!user) {
      throw fail(ctx, 404, "errors.userNotFound", "USER_NOT_FOUND");
    }
    return user;
  }

  // ADMIN permissions are implied by the role, so no rows exist for them.
  private codesOf(user: User): Promise<string[]> {
    return user.role === "ADMIN"
      ? Promise.resolve([...PERMISSION_CODES])
      : this.permissions.getUserCodes(user.id);
  }
}
