import { env } from "../../../core/config/env.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { localDayOf, startOfLocalDay } from "../../../shared/utils/deadline.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import {
  MONTHLY_PROGRESS_SORT_FIELDS,
  isMonthlyProgressSortField,
  type MonthlyProgressItemDto,
  type MonthlyProgressResult,
  type MonthlyProgressSort,
  type MonthlyProgressSortField,
} from "../dto/monthly-progress.dto.js";
import { MonthlyProgressRepository } from "../repository/monthly-progress.repository.js";
import type { MonthlyProgressQuery } from "../validators/monthly-progress.validators.js";
import { eventsByWork, villaProgressFromWorks, worksAt } from "./progress-history.js";

const DEFAULT_SORT: MonthlyProgressSort = { field: "villaNumber", direction: "asc" };

// YYYY-MM of the month after / before `month`.
export function shiftMonth(month: string, by: number): string {
  const [year, m] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (m - 1) + by;
  return `${String(Math.floor(index / 12)).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// One decimal, halves up.
const round1 = (value: number): number => Math.round(value * 10) / 10;
const average = (values: readonly number[]): number =>
  values.length === 0 ? 0 : round1(values.reduce((sum, value) => sum + value, 0) / values.length);

// Natural order of villa numbers ("V-2" before "V-10").
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// The value a sort field reads from an item.
function valueOf(
  item: MonthlyProgressItemDto,
  field: Exclude<MonthlyProgressSortField, "villaNumber">,
): number | null {
  if (field === "previous") return item.previousProgress;
  return field === "current" ? item.currentProgress : item.change;
}

function compare(a: MonthlyProgressItemDto, b: MonthlyProgressItemDto, sort: MonthlyProgressSort): number {
  const byNumber = collator.compare(a.villa.villaNumber, b.villa.villaNumber);
  if (sort.field === "villaNumber") return sort.direction === "asc" ? byNumber : -byNumber;
  const left = valueOf(a, sort.field);
  const right = valueOf(b, sort.field);
  // A villa that did not exist yet (no previous progress) goes last either way; ties fall back to the villa number.
  if (left === null || right === null) {
    if (left === right) return byNumber;
    return left === null ? 1 : -1;
  }
  const diff = (left - right) * (sort.direction === "asc" ? 1 : -1);
  return diff !== 0 ? diff : byNumber;
}

export class MonthlyProgressService {
  constructor(
    private readonly repository = new MonthlyProgressRepository(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async list(query: MonthlyProgressQuery, ctx: RequestContext): Promise<MonthlyProgressResult> {
    const now = this.clock();
    const thisMonth = localDayOf(now, env.APP_TIMEZONE).slice(0, 7);
    const month = query.month ?? thisMonth;
    if (month > thisMonth) {
      throw new AppError(400, t(ctx.locale, "errors.monthInFuture"), "MONTH_IN_FUTURE");
    }
    const isCurrentMonth = month === thisMonth;
    // The month's figures are as at its end (the first instant of the next month), or now for the current month; the
    // month before's at the first instant of this month.
    const monthStart = startOfLocalDay(`${month}-01`, env.APP_TIMEZONE);
    const monthEnd = isCurrentMonth ? now : startOfLocalDay(`${shiftMonth(month, 1)}-01`, env.APP_TIMEZONE);

    const [villas, phases, works, events] = await Promise.all([
      this.repository.villas(),
      this.repository.activePhases(),
      this.repository.works(),
      this.repository.workEvents(),
    ]);
    const byWork = eventsByWork(events);
    const previous = villaProgressFromWorks(worksAt(monthStart, works, byWork), phases);
    const current = villaProgressFromWorks(worksAt(monthEnd, works, byWork), phases);

    const term = query.search?.toLocaleLowerCase();
    const all: MonthlyProgressItemDto[] = [];
    for (const villa of villas) {
      // A villa added after a past month ended is not in it. The current month has every villa there is now (a clock a
      // little ahead of this one must not hide a villa just added).
      if (!isCurrentMonth && villa.createdAt.getTime() > monthEnd.getTime()) continue;
      const location = locationOf(villa.area.name, villa.block, villa.plot);
      if (
        term &&
        ![villa.villaNumber, location, villa.contractor?.name ?? ""].some((text) =>
          text.toLocaleLowerCase().includes(term),
        )
      ) {
        continue;
      }
      const existedBefore = villa.createdAt.getTime() <= monthStart.getTime();
      const previousProgress = existedBefore ? (previous.get(villa.id) ?? 0) : null;
      const currentProgress = current.get(villa.id) ?? 0;
      all.push({
        villa: { id: villa.id, villaNumber: villa.villaNumber, location },
        contractor: villa.contractor,
        previousProgress,
        currentProgress,
        change: round1(currentProgress - (previousProgress ?? 0)),
      });
    }

    const requested = parseSort(query.sort, MONTHLY_PROGRESS_SORT_FIELDS);
    const sort: MonthlyProgressSort =
      requested && isMonthlyProgressSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    all.sort((a, b) => compare(a, b, sort));

    const { page, limit, skip, take } = toPagination(query);
    const previousValues = all.flatMap((item) =>
      item.previousProgress === null ? [] : [item.previousProgress],
    );
    return {
      items: all.slice(skip, skip + take),
      meta: buildMeta(page, limit, all.length),
      summary: {
        month,
        previousMonth: shiftMonth(month, -1),
        isCurrentMonth,
        villaCount: all.length,
        averagePrevious: average(previousValues),
        averageCurrent: average(all.map((item) => item.currentProgress)),
        averageChange: average(all.map((item) => item.change)),
        improvedCount: all.filter((item) => item.change > 0).length,
        unchangedCount: all.filter((item) => item.change === 0).length,
      },
    };
  }
}
