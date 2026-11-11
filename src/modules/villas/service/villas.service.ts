import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { toDay } from "../../../shared/utils/day.js";
import {
  foreignKeyConstraint,
  isForeignKeyViolation,
  isRecordNotFound,
  uniqueViolationConstraint,
} from "../../../shared/utils/index.js";
import { countLabourOfVilla } from "../../daily-labour/repository/daily-labour-rows.js";
import { countDeliveriesOfVilla } from "../../materials/repository/material-delivery-rows.js";
import { countManualItemsOfVilla } from "../../open-works/repository/work-item-rows.js";
import { countSiteReportsOfVilla } from "../../site-reports/repository/site-report-rows.js";
import { countSmallWorksOfVilla } from "../../small-works/repository/small-work-rows.js";
import { removeVillaDocuments } from "../../villa-documents/index.js";
import {
  DEFAULT_CURRENCY,
  VILLA_SORT_FIELDS,
  isVillaSortField,
  type VillaDetailDto,
  type VillaFiltersDto,
  type VillaListItemDto,
  type VillaListResult,
  type VillaOptionDto,
  type VillaSnapshot,
  type VillaSort,
} from "../dto/villas.dto.js";
import {
  toDetailDto,
  toListItemDto,
  toMarkSnapshot,
  toOptionDto,
  toSnapshot,
} from "../mapper/villas.mapper.js";
import {
  VillasRepository,
  type Db,
  type VillaListRow,
  type VillaPatch,
  type VillaMark,
  type VillaSnapshotRow,
} from "../repository/villas.repository.js";
import type {
  CreateVillaInput,
  ListVillasQuery,
  MewStatesInput,
  UpdateVillaInput,
} from "../validators/villas.validators.js";
import { contractorChangeHooks, type ContractorChangeHook } from "./villa-hooks.js";
import { buildVillaReferences, type VillaReferences } from "./villa-references.js";

const DEFAULT_SORT: VillaSort = { field: "location", direction: "asc" };
const ENTITY = "Villa";

// The fields a PATCH can change.
const PATCH_KEYS = [
  "villaNumber",
  "ownerName",
  "villaType",
  "areaId",
  "block",
  "plot",
  "civilEngineerId",
  "electricalEngineerId",
  "contractorId",
  "startDate",
  "targetDate",
  "budgetMinor",
  "currency",
] as const;

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const notFound = (ctx: RequestContext): AppError => fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");
const areaNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.areaNotFound", "AREA_NOT_FOUND");
const engineerNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.civilEngineerNotFound", "CIVIL_ENGINEER_NOT_FOUND");
const electricalEngineerNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.electricalEngineerNotFound", "ELECTRICAL_ENGINEER_NOT_FOUND");
const contractorNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.contractorNotFound", "CONTRACTOR_NOT_FOUND");

// Open works that people typed in for the villa, and any daily report, daily small work or site report, stop its deletion: they decide
// first. The automatic open works go with it.
const hasRecords = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaHasRecords", "VILLA_HAS_RECORDS");

// Marking a villa that is marked, or undoing one that is not, is a conflict with its current state, not a no-op.
const alreadyMewFollowUp = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaAlreadyMewFollowUp", "VILLA_ALREADY_MEW_FOLLOW_UP");
const notMewFollowUp = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaNotMewFollowUp", "VILLA_NOT_MEW_FOLLOW_UP");
const alreadyMewInspection = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaAlreadyMewInspection", "VILLA_ALREADY_MEW_INSPECTION");
// MEW inspects a villa only after both files went in: the AC and the electricity MEW states must be past NOT_SUBMITTED.
const mewNotSubmitted = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaMewNotSubmitted", "VILLA_MEW_NOT_SUBMITTED");
const notMewInspection = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaNotMewInspection", "VILLA_NOT_MEW_INSPECTION");
const alreadyMewInspectionPassed = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaAlreadyMewInspectionPassed", "VILLA_ALREADY_MEW_INSPECTION_PASSED");
const notMewInspectionPassed = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.villaNotMewInspectionPassed", "VILLA_NOT_MEW_INSPECTION_PASSED");

// What putting each mark on (or taking it off) answers and writes in the audit log.
const MARKS: Record<
  VillaMark,
  {
    action: { on: string; off: string };
    already: (ctx: RequestContext) => AppError;
    missing: (ctx: RequestContext) => AppError;
  }
> = {
  mewFollowUp: {
    action: { on: "villa.mew_follow_up", off: "villa.mew_follow_up_undo" },
    already: alreadyMewFollowUp,
    missing: notMewFollowUp,
  },
  mewInspection: {
    action: { on: "villa.mew_inspection", off: "villa.mew_inspection_undo" },
    already: alreadyMewInspection,
    missing: notMewInspection,
  },
  mewInspectionPassed: {
    action: { on: "villa.mew_inspection_passed", off: "villa.mew_inspection_passed_undo" },
    already: alreadyMewInspectionPassed,
    missing: notMewInspectionPassed,
  },
};

// A party that is switched off cannot be put on a villa. 400, as for any other value the request may not carry.
const engineerInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.civilEngineerInactive", "CIVIL_ENGINEER_INACTIVE");
const electricalEngineerInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.electricalEngineerInactive", "ELECTRICAL_ENGINEER_INACTIVE");
const contractorInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 400, "errors.contractorInactive", "CONTRACTOR_INACTIVE");

function validationFailed(ctx: RequestContext, path: string, key: MessageKey): AppError {
  return new AppError(400, t(ctx.locale, "errors.validation"), "VALIDATION_ERROR", [
    { path, message: t(ctx.locale, key) },
  ]);
}

function patchOf(input: UpdateVillaInput): VillaPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch as VillaPatch;
}

// Dates are recorded as the day they are (YYYY-MM-DD), like the snapshot of the row they replace.
const asRecorded = (value: unknown): unknown => (value instanceof Date ? toDay(value) : value);

// A snapshot of a freshly written villa, for the audit entry.
function snapshotOfListRow(row: VillaListRow): VillaSnapshot {
  return toSnapshot({
    villaNumber: row.villaNumber,
    ownerName: row.ownerName,
    villaType: row.villaType,
    areaId: row.areaId,
    block: row.block,
    plot: row.plot,
    civilEngineerId: row.civilEngineer.id,
    electricalEngineerId: row.electricalEngineer?.id ?? null,
    contractorId: row.contractor?.id ?? null,
    startDate: row.startDate,
    targetDate: row.targetDate,
    budgetMinor: row.budgetMinor,
    currency: row.currency,
  });
}

// The budget pair a new villa gets: no budget, no currency; a budget without a currency is in KWD.
function newBudget(input: CreateVillaInput): { budgetMinor: number | null; currency: string | null } {
  const budgetMinor = input.budgetMinor ?? null;
  return { budgetMinor, currency: budgetMinor === null ? null : (input.currency ?? DEFAULT_CURRENCY) };
}

export class VillasService {
  constructor(
    private readonly repository = new VillasRepository(),
    private readonly contractorHooks: readonly ContractorChangeHook[] = contractorChangeHooks,
  ) {}

  // How an export of villas writes the areas and the parties, so that its file imports back to the same records.
  async referenceBook(): Promise<VillaReferences> {
    const [areas, civilEngineers, electricalEngineers, contractors] = await Promise.all([
      this.repository.importAreas(),
      this.repository.importCivilEngineers(),
      this.repository.importElectricalEngineers(),
      this.repository.importContractors(),
    ]);
    return buildVillaReferences({ areas, civilEngineers, electricalEngineers, contractors });
  }

  async list(query: ListVillasQuery): Promise<VillaListResult> {
    const requested = parseSort(query.sort, VILLA_SORT_FIELDS);
    const sort: VillaSort =
      requested && isVillaSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { rows, total } = await this.repository.list({
      filters: {
        area: query.area,
        areaId: query.areaId,
        block: query.block,
        plot: query.plot,
        civilEngineerId: query.civilEngineerId,
        electricalEngineerId: query.electricalEngineerId,
        contractorId: query.contractorId,
        mewFollowUp: query.mewFollowUp,
        mewInspection: query.mewInspection,
        mewInspectionPassed: query.mewInspectionPassed,
        villaType: query.villaType,
        startFrom: query.startFrom,
        startTo: query.startTo,
        targetFrom: query.targetFrom,
        targetTo: query.targetTo,
        search: query.search,
      },
      sort,
      skip,
      take,
    });
    return { items: rows.map(toListItemDto), meta: buildMeta(page, limit, total) };
  }

  async options(): Promise<VillaOptionDto[]> {
    return (await this.repository.options()).map(toOptionDto);
  }

  filters(): Promise<VillaFiltersDto> {
    return this.repository.filterOptions();
  }

  async get(id: string, ctx: RequestContext): Promise<VillaDetailDto> {
    const row = await this.repository.findDetail(id);
    if (!row) {
      throw notFound(ctx);
    }
    return toDetailDto(row);
  }

  async create(actor: Actor, input: CreateVillaInput, ctx: RequestContext): Promise<VillaListItemDto> {
    await this.requireArea(input.areaId, ctx);
    await this.requireActiveCivilEngineer(input.civilEngineerId, ctx);
    if (input.electricalEngineerId) {
      await this.requireActiveElectricalEngineer(input.electricalEngineerId, ctx);
    }
    if (input.contractorId) {
      await this.requireActiveContractor(input.contractorId, ctx);
    }
    const budget = newBudget(input);

    try {
      const created = await this.repository.transaction(async (tx) => {
        // The villa and its progress rows (one per phase) are created together, taking turns with the phases being
        // created or deleted, so no phase is left without a row for this villa.
        await this.repository.lockPhaseSet(tx);
        const row = await this.repository.create(
          {
            villaNumber: input.villaNumber,
            ownerName: input.ownerName ?? null,
            villaType: input.villaType ?? null,
            areaId: input.areaId,
            block: input.block,
            plot: input.plot,
            civilEngineerId: input.civilEngineerId,
            electricalEngineerId: input.electricalEngineerId ?? null,
            contractorId: input.contractorId ?? null,
            createdById: actor.id,
            startDate: input.startDate ?? null,
            targetDate: input.targetDate ?? null,
            ...budget,
          },
          tx,
        );
        await this.repository.insertProgressRows(row.id, tx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "villa.create",
            entity: ENTITY,
            entityId: row.id,
            after: snapshotOfListRow(row),
          }),
        );
        return row;
      });
      return toListItemDto(created);
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateVillaInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaListItemDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        // Everything the update depends on is read after the row is locked, so it cannot change underneath it.
        const { snapshot: existingRow, version } = await this.lock(id, expectedVersion, ctx, tx);
        const current = toSnapshot(existingRow);

        // A party is checked only when this request sets or changes it: a villa that already points at a party
        // that was switched off since stays valid and can still be saved.
        if (input.areaId !== undefined && input.areaId !== current.areaId) {
          await this.requireArea(input.areaId, ctx);
        }
        if (input.civilEngineerId !== undefined && input.civilEngineerId !== current.civilEngineerId) {
          await this.requireActiveCivilEngineer(input.civilEngineerId, ctx);
        }
        if (input.electricalEngineerId && input.electricalEngineerId !== current.electricalEngineerId) {
          await this.requireActiveElectricalEngineer(input.electricalEngineerId, ctx);
        }
        if (input.contractorId && input.contractorId !== current.contractorId) {
          await this.requireActiveContractor(input.contractorId, ctx);
        }
        this.checkDateOrder(input, current, ctx);

        const patch: VillaPatch = { ...patchOf(input), ...this.budgetPatch(input, current, ctx) };
        const { before, after } = this.changes(current, patch);

        if (!(await this.repository.updateScalars(id, version, patch, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? version);
        }
        const row = await this.repository.findListRow(id, tx);
        if (!row) {
          throw notFound(ctx);
        }
        // The contractor was set, replaced or cleared: whatever follows it (the open works) moves with it, in this
        // transaction, so a failure undoes the update too.
        if (input.contractorId !== undefined && input.contractorId !== current.contractorId) {
          for (const hook of this.contractorHooks) {
            await hook(tx, {
              villaId: id,
              before: current.contractorId,
              after: input.contractorId,
              actor,
              ctx,
            });
          }
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "villa.update",
            entity: ENTITY,
            entityId: id,
            before,
            after,
          }),
        );
        return row;
      });
      return toListItemDto(updated);
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  // Puts the villa on the MEW follow-up list, or takes it off.
  markMewFollowUp(
    actor: Actor,
    id: string,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaListItemDto> {
    return this.changeMark("mewFollowUp", actor, id, ctx, expectedVersion, true);
  }

  undoMewFollowUp(
    actor: Actor,
    id: string,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaListItemDto> {
    return this.changeMark("mewFollowUp", actor, id, ctx, expectedVersion, false);
  }

  // Puts the villa on the MEW inspection list, or takes it off.
  markMewInspection(
    actor: Actor,
    id: string,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaListItemDto> {
    return this.changeMark("mewInspection", actor, id, ctx, expectedVersion, true);
  }

  undoMewInspection(
    actor: Actor,
    id: string,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaListItemDto> {
    return this.changeMark("mewInspection", actor, id, ctx, expectedVersion, false);
  }

  // Checks the villa as having passed the MEW inspection (it then leaves the MEW inspection list), or takes that back.
  markMewInspectionPassed(
    actor: Actor,
    id: string,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaListItemDto> {
    return this.changeMark("mewInspectionPassed", actor, id, ctx, expectedVersion, true);
  }

  undoMewInspectionPassed(
    actor: Actor,
    id: string,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaListItemDto> {
    return this.changeMark("mewInspectionPassed", actor, id, ctx, expectedVersion, false);
  }

  // The same steps as changeInspection, on one of the MEW marks: lock the villa, check its version, refuse a mark that is
  // already as asked, write it (compare-and-set) and audit it.
  private async changeMark(
    mark: VillaMark,
    actor: Actor,
    id: string,
    ctx: RequestContext,
    expectedVersion: number | undefined,
    on: boolean,
  ): Promise<VillaListItemDto> {
    const rules = MARKS[mark];
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const version = await this.repository.lockVersion(id, tx);
        if (version === null) {
          throw notFound(ctx);
        }
        assertVersion(ctx.locale, expectedVersion, version);

        const current = await this.repository.findMark(id, mark, tx);
        if (!current) {
          throw notFound(ctx);
        }
        if (on === (current.at !== null)) {
          throw on ? rules.already(ctx) : rules.missing(ctx);
        }
        if (mark === "mewInspection" && on) {
          const states = await this.repository.findMewStates(id, tx);
          if (states && (states.mewAcState === "NOT_SUBMITTED" || states.mewElecState === "NOT_SUBMITTED")) {
            throw mewNotSubmitted(ctx);
          }
        }

        const value = on ? { at: new Date(), byId: actor.id } : null;
        if (!(await this.repository.setMark(id, version, mark, value, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? version);
        }
        const row = await this.repository.findListRow(id, tx);
        if (!row) {
          throw notFound(ctx);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: on ? rules.action.on : rules.action.off,
            entity: ENTITY,
            entityId: id,
            before: toMarkSnapshot(mark, current),
            after: toMarkSnapshot(mark, value),
          }),
        );
        return row;
      });
      return toListItemDto(updated);
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  // Sets the villa's MEW AC state, its MEW electricity state and its MEW inspection day: any of them.
  async setMewStates(
    actor: Actor,
    id: string,
    input: MewStatesInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaListItemDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const version = await this.repository.lockVersion(id, tx);
        if (version === null) {
          throw notFound(ctx);
        }
        assertVersion(ctx.locale, expectedVersion, version);
        const stored = await this.repository.findMewStates(id, tx);
        if (!stored) {
          throw notFound(ctx);
        }
        const before = {
          mewAcState: stored.mewAcState,
          mewElecState: stored.mewElecState,
          mewInspectionDate: stored.mewInspectionDate ? toDay(stored.mewInspectionDate) : null,
        };
        const after = {
          mewAcState: input.mewAcState ?? before.mewAcState,
          mewElecState: input.mewElecState ?? before.mewElecState,
          mewInspectionDate:
            input.mewInspectionDate === undefined
              ? before.mewInspectionDate
              : input.mewInspectionDate && toDay(input.mewInspectionDate),
        };
        const changed =
          after.mewAcState !== before.mewAcState ||
          after.mewElecState !== before.mewElecState ||
          after.mewInspectionDate !== before.mewInspectionDate;
        if (changed) {
          if (!(await this.repository.setMewStates(id, version, input, tx))) {
            throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? version);
          }
          await audit.record(
            tx,
            withMeta(ctx, {
              actorId: actor.id,
              action: "villa.mew_states",
              entity: ENTITY,
              entityId: id,
              before,
              after,
            }),
          );
        }
        const row = await this.repository.findListRow(id, tx);
        if (!row) {
          throw notFound(ctx);
        }
        return row;
      });
      return toListItemDto(updated);
    } catch (err) {
      return this.mapWriteError(err, ctx);
    }
  }

  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const { snapshot: row, version } = await this.lock(id, expectedVersion, ctx, tx);
        // The villa is locked, so no open work, small work, site report or labour row can be added for it between these counts and
        // the delete (the foreign keys of the small works, site reports and labour are the backstop). Daily reports belong to
        // contractors, not to villas, so they are not counted.
        if (
          (await countManualItemsOfVilla(id, tx)) > 0 ||
          (await countSmallWorksOfVilla(id, tx)) > 0 ||
          (await countSiteReportsOfVilla(id, tx)) > 0 ||
          (await countLabourOfVilla(id, tx)) > 0 ||
          (await countDeliveriesOfVilla(id, tx)) > 0
        ) {
          throw hasRecords(ctx);
        }
        if (!(await this.repository.delete(id, version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "villa.delete",
            entity: ENTITY,
            entityId: id,
            before: toSnapshot(row),
          }),
        );
      });
    } catch (err) {
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      // A report, small work or site report was saved after the counts above: the foreign key (onDelete: Restrict) still stops the delete.
      if (isForeignKeyViolation(err)) {
        throw hasRecords(ctx);
      }
      throw err;
    }
    await removeVillaDocuments(id);
  }

  // Locks the villa for this transaction, refuses a version the caller did not read, and returns the row as it is
  // now (and its version): what the audit entry records as "before" is exactly what the write replaces.
  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<{ snapshot: VillaSnapshotRow; version: number }> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) {
      throw notFound(ctx);
    }
    assertVersion(ctx.locale, expectedVersion, version);
    const snapshot = await this.repository.findSnapshot(id, tx);
    if (!snapshot) {
      throw notFound(ctx);
    }
    return { snapshot, version };
  }

  private async requireArea(id: string, ctx: RequestContext): Promise<void> {
    if (!(await this.repository.areaExists(id))) {
      throw areaNotFound(ctx);
    }
  }

  private async requireActiveCivilEngineer(id: string, ctx: RequestContext): Promise<void> {
    const status = await this.repository.civilEngineerStatus(id);
    if (status === null) {
      throw engineerNotFound(ctx);
    }
    if (status === "INACTIVE") {
      throw engineerInactive(ctx);
    }
  }

  private async requireActiveElectricalEngineer(id: string, ctx: RequestContext): Promise<void> {
    const status = await this.repository.electricalEngineerStatus(id);
    if (status === null) {
      throw electricalEngineerNotFound(ctx);
    }
    if (status === "INACTIVE") {
      throw electricalEngineerInactive(ctx);
    }
  }

  private async requireActiveContractor(id: string, ctx: RequestContext): Promise<void> {
    const status = await this.repository.contractorStatus(id);
    if (status === null) {
      throw contractorNotFound(ctx);
    }
    if (status === "INACTIVE") {
      throw contractorInactive(ctx);
    }
  }

  // The body schema can only compare dates that are both in the request. This compares the values the
  // villa will have after the update, so sending one date cannot leave the pair inverted.
  private checkDateOrder(input: UpdateVillaInput, current: VillaSnapshot, ctx: RequestContext): void {
    const dayOf = (sent: Date | null | undefined, stored: string | null): string | null =>
      sent === undefined ? stored : sent === null ? null : toDay(sent);
    const start = dayOf(input.startDate, current.startDate);
    const target = dayOf(input.targetDate, current.targetDate);
    if (start && target && target < start) {
      throw validationFailed(ctx, "targetDate", "validation.targetBeforeStart");
    }
  }

  // The budget and its currency always travel as a pair. null removes both; a budget keeps the villa's currency,
  // or gets KWD when it had none; a currency alone only makes sense for a villa that has a budget.
  private budgetPatch(input: UpdateVillaInput, current: VillaSnapshot, ctx: RequestContext): VillaPatch {
    if (input.budgetMinor === undefined && input.currency === undefined) {
      return {};
    }
    const budgetMinor = input.budgetMinor !== undefined ? input.budgetMinor : current.budgetMinor;
    if (budgetMinor === null) {
      if (input.currency !== undefined) {
        throw validationFailed(ctx, "currency", "validation.currencyWithoutBudget");
      }
      return { budgetMinor: null, currency: null };
    }
    return { budgetMinor, currency: input.currency ?? current.currency ?? DEFAULT_CURRENCY };
  }

  // Only the fields whose value actually changes are recorded, so an audit entry shows what really differs.
  private changes(
    current: VillaSnapshot,
    patch: VillaPatch,
  ): { before: Record<string, unknown>; after: Record<string, unknown> } {
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of PATCH_KEYS) {
      if (patch[key] === undefined) {
        continue;
      }
      const next = asRecorded(patch[key]);
      if (current[key] !== next) {
        before[key] = current[key];
        after[key] = next;
      }
    }
    return { before, after };
  }

  // Turns a database error from a write into the matching API error. The constraint name says which rule failed.
  private mapWriteError(err: unknown, ctx: RequestContext): never {
    const unique = uniqueViolationConstraint(err);
    if (unique?.includes("villaNumber")) {
      throw fail(ctx, 409, "errors.villaNumberTaken", "VILLA_NUMBER_TAKEN");
    }
    if (unique?.includes("plot")) {
      throw fail(ctx, 409, "errors.villaPlotTaken", "VILLA_PLOT_TAKEN");
    }
    const foreignKey = foreignKeyConstraint(err);
    if (foreignKey?.includes("areaId")) {
      throw areaNotFound(ctx);
    }
    if (foreignKey?.includes("civilEngineerId")) {
      throw engineerNotFound(ctx);
    }
    if (foreignKey?.includes("electricalEngineerId")) {
      throw electricalEngineerNotFound(ctx);
    }
    if (foreignKey?.includes("contractorId")) {
      throw contractorNotFound(ctx);
    }
    if (isRecordNotFound(err)) {
      throw notFound(ctx);
    }
    throw err;
  }
}
