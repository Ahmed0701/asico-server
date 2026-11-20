import { audit, withMeta } from "../../../core/audit/audit.js";
import { envDeadlinePolicy } from "../../../core/config/deadlinePolicy.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { type DeadlinePolicy, zoneToday } from "../../../shared/utils/deadline.js";
import { toDay } from "../../../shared/utils/day.js";
import {
  MATERIAL_ORDER_SORT_FIELDS,
  type MaterialOrderDto,
  type MaterialOrderSortField,
  type MaterialOrdersResult,
} from "../dto/material-orders.dto.js";
import { MaterialOrdersRepository, type MaterialOrderRow } from "../repository/material-orders.repository.js";
import type {
  ListMaterialOrdersQuery,
  SetMaterialOrderInput,
} from "../validators/material-orders.validators.js";

const villaNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");
const datesInvalid = (ctx: RequestContext) =>
  new AppError(422, t(ctx.locale, "errors.materialOrderDatesInvalid"), "MATERIAL_ORDER_DATES_INVALID");

const day = (date: Date | null): string | null => (date ? toDay(date) : null);

export function toMaterialOrderDto(row: MaterialOrderRow): MaterialOrderDto {
  return {
    villa: { id: row.villaId, villaNumber: row.villaNumber },
    type: row.type,
    factory: row.factoryId && row.factoryName ? { id: row.factoryId, name: row.factoryName } : null,
    mrDate: day(row.mrDate),
    poDate: day(row.poDate),
    dueDate: day(row.dueDate),
    deliveryMrDate: day(row.deliveryMrDate),
    deliveryPoDate: day(row.deliveryPoDate),
    lastDeliveryDate: day(row.lastDeliveryDate),
    requiredItems: row.requiredItems,
    completeItems: row.completeItems,
    status: row.status,
    overdue: row.overdue,
  };
}

/**
 * The Material Orders tab: each villa's switchgear and cables, with the dates of their material request (MR), purchase
 * order (PO) and when they are due, and whether everything came. The dates are entered per villa and type.
 */
export class MaterialOrdersService {
  constructor(
    private readonly repository = new MaterialOrdersRepository(),
    private readonly now: () => Date = () => new Date(),
    private readonly policy: Pick<DeadlinePolicy, "timeZone"> = envDeadlinePolicy(),
  ) {}

  private today(): Date {
    return zoneToday(this.now(), this.policy.timeZone);
  }

  async list(query: ListMaterialOrdersQuery): Promise<MaterialOrdersResult> {
    const { page, limit, skip, take } = toPagination(query);
    const requested = parseSort(query.sort, MATERIAL_ORDER_SORT_FIELDS);
    const sort = requested
      ? { field: requested.field as MaterialOrderSortField, direction: requested.direction }
      : { field: "villaNumber" as const, direction: "asc" as const };
    const { rows, total, summary } = await this.repository.list({
      search: query.search,
      type: query.type,
      status: query.status,
      overdue: query.overdue,
      today: this.today(),
      sort,
      skip,
      take,
    });
    return { items: rows.map(toMaterialOrderDto), meta: buildMeta(page, limit, total), summary };
  }

  // Sets the MR, PO and due dates of a villa's materials of one type (null clears one), audited as a change of the
  // villa, and answers the row.
  async set(
    actor: Actor,
    villaId: string,
    type: FactoryTypeValue,
    input: SetMaterialOrderInput,
    ctx: RequestContext,
  ): Promise<MaterialOrderDto> {
    if (input.mrDate && input.poDate && input.poDate.getTime() < input.mrDate.getTime())
      throw datesInvalid(ctx);
    await this.repository.transaction(async (tx) => {
      const villaNumber = await this.repository.villaNumber(villaId, tx);
      if (villaNumber === null) throw villaNotFound(ctx);
      const before = await this.repository.findOrder(villaId, type, tx);
      await this.repository.saveOrder(villaId, type, input, tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "material_order.update",
          entity: "Villa",
          entityId: villaId,
          before: {
            villaNumber,
            type,
            mrDate: day(before?.mrDate ?? null),
            poDate: day(before?.poDate ?? null),
            dueDate: day(before?.dueDate ?? null),
          },
          after: {
            villaNumber,
            type,
            mrDate: day(input.mrDate),
            poDate: day(input.poDate),
            dueDate: day(input.dueDate),
          },
        }),
      );
    });
    const { rows } = await this.repository.list({
      villaId,
      type,
      today: this.today(),
      sort: { field: "villaNumber", direction: "asc" },
      skip: 0,
      take: 1,
    });
    return toMaterialOrderDto(rows[0]!);
  }
}
