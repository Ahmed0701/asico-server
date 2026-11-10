import { audit, withMeta } from "../../../core/audit/audit.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { PERMISSION_CODES } from "../../../shared/constants/permissions.js";
import type { PermissionGroupDto, UserPermissionsDto } from "../dto/permissions.dto.js";
import { toPermissionGroups, toUserPermissionsDto } from "../mapper/permissions.mapper.js";
import { PermissionsRepository } from "../repository/permissions.repository.js";

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

export class PermissionsService {
  constructor(private readonly repository = new PermissionsRepository()) {}

  async list(): Promise<PermissionGroupDto[]> {
    return toPermissionGroups(await this.repository.listCodes());
  }

  async getForUser(userId: string, ctx: RequestContext): Promise<UserPermissionsDto> {
    const user = await this.repository.findUser(userId);
    if (!user) {
      throw fail(ctx, 404, "errors.userNotFound", "USER_NOT_FOUND");
    }
    // ADMIN permissions are implied by the role, so no rows exist for them.
    const codes = user.role === "ADMIN" ? [...PERMISSION_CODES] : await this.repository.getUserCodes(userId);
    return toUserPermissionsDto(userId, codes);
  }

  async replaceForUser(
    actor: Actor,
    userId: string,
    codes: readonly string[],
    ctx: RequestContext,
  ): Promise<UserPermissionsDto> {
    const user = await this.repository.findUser(userId);
    if (!user) {
      throw fail(ctx, 404, "errors.userNotFound", "USER_NOT_FOUND");
    }
    if (user.role === "ADMIN") {
      throw fail(ctx, 403, "errors.adminPermissionsImmutable", "ADMIN_PERMISSIONS_IMMUTABLE");
    }
    // Otherwise anyone holding permissions:assign could grant themselves everything.
    if (user.id === actor.id) {
      throw fail(ctx, 403, "errors.cannotModifyOwnPermissions", "CANNOT_MODIFY_OWN_PERMISSIONS");
    }

    const { after } = await this.repository.transaction(async (tx) => {
      const change = await this.repository.setUserCodes(userId, codes, tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "user.permissions_replaced",
          entity: "User",
          entityId: userId,
          before: { permissions: change.before },
          after: { permissions: change.after },
        }),
      );
      return change;
    });
    return toUserPermissionsDto(userId, after);
  }
}
