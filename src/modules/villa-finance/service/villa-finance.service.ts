import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { fill } from "../../../core/i18n/fill.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { uniqueViolationConstraint } from "../../../shared/utils/index.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import {
  VILLA_FINANCE_SORT_FIELDS,
  type VillaFinanceDto,
  type VillaFinanceListItemDto,
  type VillaFinanceListResult,
  type VillaFinanceSortField,
} from "../dto/villa-finance.dto.js";
import {
  VillaFinanceRepository,
  type FinanceFields,
  type VillaMoneyRow,
} from "../repository/villa-finance.repository.js";
import {
  MAX_SALARY_SHARE_BP,
  type ListVillaFinanceQuery,
  type PutVillaFinanceInput,
} from "../validators/villa-finance.validators.js";

const villaNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");

// The costs a save may set; the salaries are worked out from the share.
const AMOUNTS = ["workOrderMinor", "materialsMinor", "pettyCashMinor"] as const;
const COSTS = [
  "workOrderMinor",
  "salariesMinor",
  "materialsMinor",
  "pettyCashMinor",
  "expensesMinor",
] as const;

const shareOver = (ctx: RequestContext, availableBp: number) =>
  new AppError(
    422,
    fill(t(ctx.locale, "errors.salaryShareOverLimit"), { available: (availableBp / 100).toFixed(2) }),
    "SALARY_SHARE_OVER_LIMIT",
  );

// A share of the overhead salaries, rounded to the fils.
export const salariesOf = (overheadMinor: number, shareBp: number | null): number | null =>
  shareBp === null ? null : Math.round((overheadMinor * shareBp) / 10_000);

const num = (value: bigint | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export function toVillaFinanceDto(row: VillaMoneyRow): VillaFinanceDto {
  const f = row.finance;
  const overheadSalariesMinor = Number(row.overheadSalariesMinor);
  const salaryShareBp = f?.salaryShareBp ?? null;
  const values = {
    workOrderMinor: num(f?.workOrderMinor),
    salariesMinor: salariesOf(overheadSalariesMinor, salaryShareBp),
    materialsMinor: num(f?.materialsMinor),
    pettyCashMinor: num(f?.pettyCashMinor),
    // The additional expenses entered for the villa on the Department Overhead page.
    expensesMinor: Number(row.expensesMinor),
  };
  const totalCostsMinor = COSTS.reduce((sum, key) => sum + (values[key] ?? 0), 0);
  const budget = num(row.budgetMinor);
  const variationOrdersMinor = Number(row.variationOrdersMinor);
  // The variation orders and the costs are in KWD: the totals are worked out only with a KWD budget (or none).
  const inKwd = row.currency === null || row.currency === "KWD";
  const totalBudgetMinor =
    !inKwd || (budget === null && variationOrdersMinor === 0) ? null : (budget ?? 0) + variationOrdersMinor;
  return {
    villaId: row.id,
    budgetMinor: budget,
    currency: row.currency,
    variationOrdersMinor,
    totalBudgetMinor,
    ...values,
    salaryShareBp,
    overheadSalariesMinor,
    totalCostsMinor,
    remainingMinor: totalBudgetMinor === null ? null : totalBudgetMinor - totalCostsMinor,
    version: f?.version ?? 0,
    updatedAt: f?.updatedAt.toISOString() ?? null,
    updatedBy: f?.updatedBy ?? null,
  };
}

// What the audit entry records.
const snapshotOf = (row: VillaMoneyRow) => ({
  villaNumber: row.villaNumber,
  budgetMinor: num(row.budgetMinor),
  currency: row.currency,
  workOrderMinor: num(row.finance?.workOrderMinor),
  salaryShareBp: row.finance?.salaryShareBp ?? null,
  materialsMinor: num(row.finance?.materialsMinor),
  pettyCashMinor: num(row.finance?.pettyCashMinor),
});

// Natural order of villa numbers (V-2 before V-10).
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function valueOf(item: VillaFinanceListItemDto, field: VillaFinanceSortField): number | null {
  if (field === "totalBudget") return item.totalBudgetMinor;
  if (field === "totalCosts") return item.totalCostsMinor;
  return item.remainingMinor;
}

export class VillaFinanceService {
  constructor(private readonly repository = new VillaFinanceRepository()) {}

  async get(villaId: string, ctx: RequestContext): Promise<VillaFinanceDto> {
    const row = await this.repository.find(villaId);
    if (!row) throw villaNotFound(ctx);
    return toVillaFinanceDto(row);
  }

  // Every villa's figures (the Projects Budgets page), searched, sorted and paged, with the totals over the search.
  async list(query: ListVillaFinanceQuery): Promise<VillaFinanceListResult> {
    const term = query.search?.toLocaleLowerCase();
    const all: VillaFinanceListItemDto[] = [];
    const rows = await this.repository.all();
    for (const row of rows) {
      const location = locationOf(row.area.name, row.block, row.plot);
      if (term && ![row.villaNumber, location].some((text) => text.toLocaleLowerCase().includes(term)))
        continue;
      all.push({ ...toVillaFinanceDto(row), villa: { id: row.id, villaNumber: row.villaNumber, location } });
    }

    const requested = parseSort(query.sort, VILLA_FINANCE_SORT_FIELDS);
    const field = (requested?.field ?? "villaNumber") as VillaFinanceSortField;
    const sign = requested?.direction === "desc" ? -1 : 1;
    all.sort((a, b) => {
      const byNumber = collator.compare(a.villa.villaNumber, b.villa.villaNumber);
      if (field === "villaNumber") return byNumber * sign;
      const left = valueOf(a, field);
      const right = valueOf(b, field);
      // Villas without the figure go last either way.
      if (left === null || right === null) return left === right ? byNumber : left === null ? 1 : -1;
      return (left - right) * sign || byNumber;
    });

    const kwd = all.filter((item) => item.totalBudgetMinor !== null || item.currency === null);
    const sum = (pick: (item: VillaFinanceListItemDto) => number | null) =>
      kwd.reduce((total, item) => total + (pick(item) ?? 0), 0);
    const { page, limit, skip, take } = toPagination(query);
    return {
      items: all.slice(skip, skip + take),
      meta: buildMeta(page, limit, all.length),
      summary: {
        villaCount: all.length,
        budgetMinor: sum((item) => item.budgetMinor),
        variationOrdersMinor: sum((item) => item.variationOrdersMinor),
        totalBudgetMinor: sum((item) => item.totalBudgetMinor),
        totalCostsMinor: sum((item) => item.totalCostsMinor),
        remainingMinor: sum((item) => item.remainingMinor),
        overBudgetCount: all.filter((item) => item.remainingMinor !== null && item.remainingMinor < 0).length,
        overheadSalariesMinor: Number(
          rows[0]?.overheadSalariesMinor ?? (await this.repository.overheadSalaries()),
        ),
        allocatedShareBp: rows.reduce((total, row) => total + (row.finance?.salaryShareBp ?? 0), 0),
      },
    };
  }

  // Saves what is sent (null clears a value): the villa's budget, and the four figures. `expectedVersion` is the If-Match
  // of the figures; the first save sends none (there is no version yet). Two first saves at once: the second finds the
  // row made, and is told the villa changed (409).
  async update(
    actor: Actor,
    villaId: string,
    input: PutVillaFinanceInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaFinanceDto> {
    let saved: VillaMoneyRow;
    try {
      saved = await this.repository.transaction(async (tx) => {
        if (!(await this.repository.lock(villaId, tx))) throw villaNotFound(ctx);
        const before = await this.repository.find(villaId, tx);
        if (!before) throw villaNotFound(ctx);
        assertVersion(ctx.locale, expectedVersion, before.finance?.version ?? 0);
        if (input.budgetMinor !== undefined) {
          await this.repository.saveBudget(
            villaId,
            input.budgetMinor === null ? null : BigInt(input.budgetMinor),
            tx,
          );
        }
        const data: FinanceFields = {};
        for (const key of AMOUNTS) {
          const value = input[key];
          if (value !== undefined) data[key] = value === null ? null : BigInt(value);
        }
        if (input.salaryShareBp !== undefined) {
          // All villas together stay at or under 100%; giving less (or clearing it) is always allowed.
          const was = before.finance?.salaryShareBp ?? 0;
          if (input.salaryShareBp !== null && input.salaryShareBp > was) {
            await this.repository.lockShares(tx);
            const others = await this.repository.sharesOfOthers(villaId, tx);
            if (others + input.salaryShareBp > MAX_SALARY_SHARE_BP) {
              throw shareOver(ctx, Math.max(0, MAX_SALARY_SHARE_BP - others));
            }
          }
          data.salaryShareBp = input.salaryShareBp;
        }
        // The finance row moves on with every save (its version is what the next save matches), budget alone included.
        await this.repository.save(villaId, data, actor.id, before.finance !== null, tx);
        const after = await this.repository.find(villaId, tx);
        if (!after) throw villaNotFound(ctx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "villa.finance",
            entity: "Villa",
            entityId: villaId,
            before: snapshotOf(before),
            after: snapshotOf(after),
          }),
        );
        return after;
      });
    } catch (err) {
      if (uniqueViolationConstraint(err) !== undefined) throw versionConflict(ctx.locale, 1);
      throw err;
    }
    return toVillaFinanceDto(saved);
  }
}
