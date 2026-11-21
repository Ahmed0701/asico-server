import { audit, withMeta } from "../../../core/audit/audit.js";
import { currentVillaScope } from "../../../core/scope/villa-scope.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { isForeignKeyViolation, isRecordNotFound } from "../../../shared/utils/index.js";
import {
  ELECTRICAL_ENGINEER_SORT_FIELDS,
  isElectricalEngineerSortField,
  type ElectricalEngineerDto,
  type ElectricalEngineerListResult,
  type ElectricalEngineerOptionDto,
  type ElectricalEngineerSort,
  type ElectricalEngineerUserOptionDto,
} from "../dto/electrical-engineers.dto.js";
import { toElectricalEngineerDto, toOptionDto } from "../mapper/electrical-engineers.mapper.js";
import {
  ElectricalEngineersRepository,
  type Db,
  type ElectricalEngineerRow,
} from "../repository/electrical-engineers.repository.js";
import type {
  CreateElectricalEngineerInput,
  ListElectricalEngineersQuery,
  UpdateElectricalEngineerInput,
  TransferVillasInput,
} from "../validators/electrical-engineers.validators.js";

const DEFAULT_SORT: ElectricalEngineerSort = { field: "name", direction: "asc" };
const ENTITY = "ElectricalEngineer";

const notFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.electricalEngineerNotFound"), "ELECTRICAL_ENGINEER_NOT_FOUND");

const userNotFound = (ctx: RequestContext): AppError =>
  new AppError(404, t(ctx.locale, "errors.userNotFound"), "USER_NOT_FOUND");
const userTaken = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.engineerUserTaken"), "ENGINEER_USER_TAKEN");
const userIsAdmin = (ctx: RequestContext): AppError =>
  new AppError(422, t(ctx.locale, "errors.engineerUserAdmin"), "ENGINEER_USER_ADMIN");
const inUse = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.electricalEngineerInUse"), "ELECTRICAL_ENGINEER_IN_USE");

const snapshot = (row: Pick<ElectricalEngineerRow, "name" | "phone" | "email" | "status" | "user">) => ({
  user: row.user?.email ?? null,
  name: row.name,
  phone: row.phone,
  email: row.email,
  status: row.status,
});

export class ElectricalEngineersService {
  constructor(private readonly repository = new ElectricalEngineersRepository()) {}

  async list(query: ListElectricalEngineersQuery): Promise<ElectricalEngineerListResult> {
    const requested = parseSort(query.sort, ELECTRICAL_ENGINEER_SORT_FIELDS);
    const sort: ElectricalEngineerSort =
      requested && isElectricalEngineerSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);

    const { rows, total } = await this.repository.list({
      search: query.search,
      status: query.status,
      sort,
      skip,
      take,
    });
    return { items: rows.map(toElectricalEngineerDto), meta: buildMeta(page, limit, total) };
  }

  // The users the engineer form can link.
  async userOptions(): Promise<ElectricalEngineerUserOptionDto[]> {
    const rows = await this.repository.userOptions();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      isActive: row.isActive,
      engineer: row.electricalEngineer,
    }));
  }

  // A user may be linked to one engineer only, and never an ADMIN (an ADMIN always sees every villa).
  private async checkUser(
    userId: string,
    engineerId: string | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<void> {
    const user = await this.repository.findUser(userId, tx);
    if (!user) throw userNotFound(ctx);
    if (user.role === "ADMIN") throw userIsAdmin(ctx);
    if (user.electricalEngineer && user.electricalEngineer.id !== engineerId) throw userTaken(ctx);
  }

  async options(): Promise<ElectricalEngineerOptionDto[]> {
    return (await this.repository.options()).map(toOptionDto);
  }

  async get(id: string, ctx: RequestContext): Promise<ElectricalEngineerDto> {
    return toElectricalEngineerDto(await this.requireEngineer(id, ctx));
  }

  async create(
    actor: Actor,
    input: CreateElectricalEngineerInput,
    ctx: RequestContext,
  ): Promise<ElectricalEngineerDto> {
    const created = await this.repository.transaction(async (tx) => {
      if (input.userId) await this.checkUser(input.userId, undefined, ctx, tx);
      const row = await this.repository.create(
        {
          name: input.name,
          phone: input.phone,
          email: input.email ?? null,
          status: input.status ?? "ACTIVE",
          userId: input.userId ?? null,
        },
        tx,
      );
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "electrical_engineer.create",
          entity: ENTITY,
          entityId: row.id,
          after: snapshot(row),
        }),
      );
      return row;
    });
    return toElectricalEngineerDto(created);
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateElectricalEngineerInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<ElectricalEngineerDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        const before = snapshot(target);
        if (input.userId) await this.checkUser(input.userId, id, ctx, tx);
        const row = await this.repository.update(
          id,
          target.version,
          {
            ...(input.name !== undefined && { name: input.name }),
            ...(input.phone !== undefined && { phone: input.phone }),
            ...(input.email !== undefined && { email: input.email }),
            ...(input.status !== undefined && { status: input.status }),
            ...(input.userId !== undefined && { userId: input.userId }),
          },
          tx,
        );
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "electrical_engineer.update",
            entity: ENTITY,
            entityId: id,
            before,
            after: snapshot(row),
          }),
        );
        return row;
      });
      return toElectricalEngineerDto(updated);
    } catch (err) {
      // Someone deleted it between the lookup above and the write.
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      throw err;
    }
  }

  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    try {
      await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        // Villas and the daily reports the engineer prepared both keep an engineer from being deleted.
        if (target._count.villas > 0 || target._count.dailyReports > 0) {
          throw inUse(ctx);
        }
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "electrical_engineer.delete",
            entity: ENTITY,
            entityId: id,
            before: snapshot(target),
          }),
        );
      });
    } catch (err) {
      // A villa was linked after the check above: the foreign key (onDelete: Restrict) still stops the delete.
      if (isForeignKeyViolation(err)) {
        throw inUse(ctx);
      }
      if (isRecordNotFound(err)) {
        throw notFound(ctx);
      }
      throw err;
    }
  }

  // Locks the engineer for this transaction, refuses a version the caller did not read, and returns the row as it is
  // now: what the audit entry records as "before" is exactly what this write replaces.
  // Moves every villa of the engineer to another, active, engineer, in one transaction, so it can then be deleted. Not
  // for a user linked to an electrical engineer: its villas would leave its sight.
  async transferVillas(
    actor: Actor,
    id: string,
    input: TransferVillasInput,
    ctx: RequestContext,
  ): Promise<{ moved: number; to: { id: string; name: string } }> {
    if (currentVillaScope()) {
      throw new AppError(403, t(ctx.locale, "errors.transferByEngineer"), "FORBIDDEN");
    }
    if (input.toEngineerId === id) {
      throw new AppError(422, t(ctx.locale, "errors.transferSameEngineer"), "TRANSFER_SAME_ENGINEER");
    }
    return this.repository.transaction(async (tx) => {
      const from = await this.lock(id, undefined, ctx, tx);
      const to = await this.repository.findById(input.toEngineerId, tx);
      if (!to) throw notFound(ctx);
      if (to.status !== "ACTIVE") {
        throw new AppError(
          400,
          t(ctx.locale, "errors.electricalEngineerInactive"),
          "ELECTRICAL_ENGINEER_INACTIVE",
        );
      }
      const villaNumbers = await this.repository.villaNumbersOf(id, tx);
      const moved = await this.repository.moveVillas(id, to.id, tx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "electrical_engineer.transfer_villas",
          entity: ENTITY,
          entityId: id,
          after: { from: from.name, to: to.name, moved, villas: villaNumbers },
        }),
      );
      return { moved, to: { id: to.id, name: to.name } };
    });
  }

  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<ElectricalEngineerRow> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) {
      throw notFound(ctx);
    }
    assertVersion(ctx.locale, expectedVersion, version);
    const row = await this.repository.findById(id, tx);
    if (!row) {
      throw notFound(ctx);
    }
    return row;
  }

  private async requireEngineer(id: string, ctx: RequestContext): Promise<ElectricalEngineerRow> {
    const row = await this.repository.findById(id);
    if (!row) {
      throw notFound(ctx);
    }
    return row;
  }
}
