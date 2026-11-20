import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { foreignKeyConstraint } from "../../../shared/utils/index.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import type {
  AvailableVillaDto,
  VillaVendorsDto,
  VillaVendorsListResult,
} from "../dto/material-vendors.dto.js";
import {
  MaterialVendorsRepository,
  type Db,
  type VendorFields,
  type VendorVillaRow,
} from "../repository/material-vendors.repository.js";
import type {
  ListVillaVendorsQuery,
  PutVillaVendorsInput,
} from "../validators/material-vendors.validators.js";

const villaNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");
const factoryNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.factoryNotFound"), "FACTORY_NOT_FOUND");
const notListed = (ctx: RequestContext) =>
  new AppError(409, t(ctx.locale, "errors.villaNotInVendors"), "VILLA_NOT_IN_VENDORS");
const alreadyListed = (ctx: RequestContext) =>
  new AppError(409, t(ctx.locale, "errors.villaAlreadyInVendors"), "VILLA_ALREADY_IN_VENDORS");
const wrongType = (ctx: RequestContext) =>
  new AppError(422, t(ctx.locale, "errors.factoryWrongType"), "FACTORY_WRONG_TYPE");

// Natural order of villa numbers (V-2 before V-10).
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function toVillaVendorsDto(row: VendorVillaRow): VillaVendorsDto {
  return {
    villa: {
      id: row.id,
      villaNumber: row.villaNumber,
      location: locationOf(row.area.name, row.block, row.plot),
    },
    switchgear: row.switchgearFactory,
    cable: row.cableFactory,
    version: row.version,
    // Only listed villas are turned into this.
    listedAt: row.vendorsListedAt?.toISOString() ?? null,
  };
}

// What the audit entry records.
const snapshotOf = (row: VendorVillaRow) => ({
  villaNumber: row.villaNumber,
  switchgearFactory: row.switchgearFactory?.name ?? null,
  cableFactory: row.cableFactory?.name ?? null,
});

export class MaterialVendorsService {
  constructor(private readonly repository = new MaterialVendorsRepository()) {}

  // Each villa with its assigned factories, searched, filtered, sorted and paged, and the counts over the filters.
  async list(query: ListVillaVendorsQuery): Promise<VillaVendorsListResult> {
    const term = query.search?.toLocaleLowerCase();
    const items: VillaVendorsDto[] = [];
    for (const row of await this.repository.listed()) {
      const item = toVillaVendorsDto(row);
      if (query.factoryId && item.switchgear?.id !== query.factoryId && item.cable?.id !== query.factoryId)
        continue;
      if (query.missing === "SWITCHGEAR" && item.switchgear) continue;
      if (query.missing === "CABLE" && item.cable) continue;
      if (term) {
        const texts = [item.villa.villaNumber, item.villa.location, item.switchgear?.name, item.cable?.name];
        if (!texts.some((text) => text?.toLocaleLowerCase().includes(term))) continue;
      }
      items.push(item);
    }
    const desc = query.sort?.endsWith(":desc") ?? false;
    items.sort((a, b) => collator.compare(a.villa.villaNumber, b.villa.villaNumber) * (desc ? -1 : 1));

    const { page, limit, skip, take } = toPagination(query);
    return {
      items: items.slice(skip, skip + take),
      meta: buildMeta(page, limit, items.length),
      summary: {
        villaCount: items.length,
        withSwitchgear: items.filter((item) => item.switchgear).length,
        withCable: items.filter((item) => item.cable).length,
        withNone: await this.repository.countUnassigned(),
      },
    };
  }

  // Assigns (or with null, takes off) the villa's switchgear and cable factories. Each must exist and be of its type;
  // the factories are locked so their type cannot change meanwhile. `expectedVersion` is the villa's If-Match.
  async assign(
    actor: Actor,
    villaId: string,
    input: PutVillaVendorsInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<VillaVendorsDto> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        const version = await this.repository.lockVilla(villaId, tx);
        if (version === null) throw villaNotFound(ctx);
        assertVersion(ctx.locale, expectedVersion, version);
        const before = await this.repository.findVilla(villaId, tx);
        if (!before) throw villaNotFound(ctx);
        if (!before.vendorsListedAt) throw notListed(ctx);
        await this.check(input.switchgearFactoryId, "SWITCHGEAR", ctx, tx);
        await this.check(input.cableFactoryId, "CABLE", ctx, tx);
        const data: VendorFields = {
          ...(input.switchgearFactoryId !== undefined && { switchgearFactoryId: input.switchgearFactoryId }),
          ...(input.cableFactoryId !== undefined && { cableFactoryId: input.cableFactoryId }),
        };
        const after = await this.repository.assign(villaId, version, data, tx);
        if (!after)
          throw versionConflict(ctx.locale, (await this.repository.lockVilla(villaId, tx)) ?? version);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "villa.vendors",
            entity: "Villa",
            entityId: villaId,
            before: snapshotOf(before),
            after: snapshotOf(after),
          }),
        );
        return after;
      });
      return toVillaVendorsDto(row);
    } catch (err) {
      // A factory deleted between the check and the write: its foreign key stopped the write.
      if (foreignKeyConstraint(err) !== undefined) throw factoryNotFound(ctx);
      throw err;
    }
  }

  // One villa's assigned factories (the villa page, the delivery note form), on the list or not.
  async get(villaId: string, ctx: RequestContext): Promise<VillaVendorsDto> {
    const row = await this.repository.findVilla(villaId);
    if (!row) throw villaNotFound(ctx);
    return toVillaVendorsDto(row);
  }

  // The villas that can be added to the list, in natural order.
  async available(): Promise<AvailableVillaDto[]> {
    return (await this.repository.available()).sort((a, b) => collator.compare(a.villaNumber, b.villaNumber));
  }

  // Puts a villa on the Vendors list (nothing assigned yet).
  async add(actor: Actor, villaId: string, ctx: RequestContext): Promise<VillaVendorsDto> {
    const row = await this.repository.transaction(async (tx) => {
      const version = await this.repository.lockVilla(villaId, tx);
      if (version === null) throw villaNotFound(ctx);
      const before = await this.repository.findVilla(villaId, tx);
      if (!before) throw villaNotFound(ctx);
      if (before.vendorsListedAt) throw alreadyListed(ctx);
      const after = await this.repository.assign(villaId, version, { vendorsListedAt: new Date() }, tx);
      if (!after) throw versionConflict(ctx.locale, version);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "villa.vendors_add",
          entity: "Villa",
          entityId: villaId,
          after: snapshotOf(after),
        }),
      );
      return after;
    });
    return toVillaVendorsDto(row);
  }

  // Takes a villa off the Vendors list, and its assigned factories with it. `expectedVersion` is the villa's If-Match.
  async remove(actor: Actor, villaId: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    await this.repository.transaction(async (tx) => {
      const version = await this.repository.lockVilla(villaId, tx);
      if (version === null) throw villaNotFound(ctx);
      assertVersion(ctx.locale, expectedVersion, version);
      const before = await this.repository.findVilla(villaId, tx);
      if (!before) throw villaNotFound(ctx);
      if (!before.vendorsListedAt) throw notListed(ctx);
      const after = await this.repository.assign(
        villaId,
        version,
        { vendorsListedAt: null, switchgearFactoryId: null, cableFactoryId: null },
        tx,
      );
      if (!after) throw versionConflict(ctx.locale, version);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "villa.vendors_remove",
          entity: "Villa",
          entityId: villaId,
          before: snapshotOf(before),
        }),
      );
    });
  }

  private async check(
    factoryId: string | null | undefined,
    type: FactoryTypeValue,
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    if (!factoryId) return;
    const found = await this.repository.lockFactory(factoryId, tx);
    if (found === null) throw factoryNotFound(ctx);
    if (found !== type) throw wrongType(ctx);
  }
}
