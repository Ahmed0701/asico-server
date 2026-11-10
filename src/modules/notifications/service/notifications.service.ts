import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import type { NotificationDto, NotificationListResult } from "../dto/notifications.dto.js";
import { toNotificationDto } from "../mapper/notifications.mapper.js";
import { NotificationsRepository } from "../repository/notifications.repository.js";
import type { ListNotificationsQuery } from "../validators/notifications.validators.js";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.notificationNotFound"), "NOTIFICATION_NOT_FOUND");

// The notifications of the signed-in user, and nobody else's. They are not audited: reading is not a change worth a log
// entry, and the job that makes them writes none either.
export class NotificationsService {
  // `clock` is injectable so the time a notification was read can be tested.
  constructor(
    private readonly repository = new NotificationsRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(actor: Actor, query: ListNotificationsQuery): Promise<NotificationListResult> {
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total, unreadCount } = await this.repository.list(actor.id, {
      unread: query.unread ?? false,
      skip,
      take,
    });
    return {
      items: rows.map(toNotificationDto),
      meta: { ...buildMeta(page, limit, total), unreadCount },
    };
  }

  // Marking a notification read twice is fine: the answer is the same and the first time is kept. Someone else's, or one that
  // does not exist, is 404.
  async markRead(actor: Actor, id: string, ctx: RequestContext): Promise<NotificationDto> {
    const row = await this.repository.markRead(actor.id, id, this.clock());
    if (!row) {
      throw notFound(ctx);
    }
    return toNotificationDto(row);
  }

  async markAllRead(actor: Actor): Promise<{ updated: number }> {
    return { updated: await this.repository.markAllRead(actor.id, this.clock()) };
  }
}
