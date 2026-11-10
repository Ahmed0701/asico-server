import { audit, withMeta } from "../../../core/audit/audit.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { foreignKeyConstraint, isRecordNotFound } from "../../../shared/utils/index.js";
import {
  MAX_PROGRESS,
  stateOf,
  villaProgressOf,
  type PhaseProgressUpdateDto,
} from "../dto/villa-progress.dto.js";
import {
  VillaProgressRepository,
  type Db,
  type PhaseRow,
  type ProgressRow,
} from "../repository/villa-progress.repository.js";
import type { UpdatePhaseProgressInput } from "../validators/villa-progress.validators.js";

const ENTITY = "Villa";

function fail(ctx: RequestContext, status: number, key: MessageKey, code: string): AppError {
  return new AppError(status, t(ctx.locale, key), code);
}

const villaNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");
const phaseNotFound = (ctx: RequestContext): AppError =>
  fail(ctx, 404, "errors.elecPhaseNotFound", "ELEC_PHASE_NOT_FOUND");
// The progress of a phase that is switched off is frozen: it only drops out of the average.
const phaseInactive = (ctx: RequestContext): AppError =>
  fail(ctx, 409, "errors.elecPhaseInactive", "ELEC_PHASE_INACTIVE");

// What a progress update tells the code that reacts to it.
export type ProgressChange = {
  villaId: string;
  phase: PhaseRow;
  before: { progress: number; completedAt: Date | null };
  after: { progress: number; completedAt: Date | null };
  actor: Actor;
  ctx: RequestContext;
};

// HOOKS: each function in this list runs inside the transaction of every progress update that changed something, after
// the row is written and before the audit entry, with the transaction's client. Nothing registers one today (the open
// works no longer follow the phase progress: they are all added by hand). A hook that throws undoes the whole update. tests/modules/villa-progress covers the contract (called in the transaction,
// with before and after, not called when nothing changed or the update is refused, and a failure rolls everything back).
export type ProgressChangeHook = (tx: Db, change: ProgressChange) => Promise<void>;
export const progressChangeHooks: ProgressChangeHook[] = [];

export class VillaProgressService {
  constructor(
    private readonly repository = new VillaProgressRepository(),
    private readonly hooks: readonly ProgressChangeHook[] = progressChangeHooks,
  ) {}

  async update(
    actor: Actor,
    villaId: string,
    elecPhaseId: string,
    input: UpdatePhaseProgressInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<PhaseProgressUpdateDto> {
    try {
      return await this.repository.transaction(async (tx) => {
        // The locks are taken in the one order everything that writes a villa's rows uses (shared/constants/locks.ts): the
        // villa, the phase, then the progress row; the hooks then lock whatever comes after.
        if (!(await this.repository.lockVilla(villaId, tx))) {
          throw villaNotFound(ctx);
        }
        const phase = await this.repository.lockPhase(elecPhaseId, tx);
        if (!phase) {
          throw phaseNotFound(ctx);
        }
        if (phase.status !== "ACTIVE") {
          throw phaseInactive(ctx);
        }

        const current = await this.repository.lockRow(villaId, elecPhaseId, tx);
        assertVersion(ctx.locale, expectedVersion, current.version);

        let row: ProgressRow = current;
        // Setting what is already there changes nothing: no new version, no audit entry, no hook.
        if (current.progress !== input.progress) {
          // 100 completes the phase; anything lower clears the completion.
          const completedAt = input.progress === MAX_PROGRESS ? new Date() : null;
          const updated = await this.repository.update(
            villaId,
            elecPhaseId,
            current.version,
            { progress: input.progress, completedAt },
            tx,
          );
          if (!updated) {
            throw versionConflict(
              ctx.locale,
              (await this.repository.lockRow(villaId, elecPhaseId, tx)).version,
            );
          }
          row = updated;
          await this.runHooks(tx, {
            villaId,
            phase,
            before: { progress: current.progress, completedAt: current.completedAt },
            after: { progress: row.progress, completedAt: row.completedAt },
            actor,
            ctx,
          });
          await audit.record(
            tx,
            withMeta(ctx, {
              actorId: actor.id,
              action: "villa.progress",
              entity: ENTITY,
              entityId: villaId,
              before: { elecPhaseId, phase: phase.name, progress: current.progress },
              after: { elecPhaseId, phase: phase.name, progress: row.progress },
            }),
          );
        }

        const { doneRatio, count } = await this.repository.totals(villaId, tx);
        return {
          elecPhaseId,
          name: phase.name,
          order: phase.sortOrder,
          progress: row.progress,
          state: stateOf(row.progress),
          version: row.version,
          villaProgress: villaProgressOf(doneRatio),
          phaseCount: count,
        };
      });
    } catch (err) {
      // The villa or the phase was deleted between the checks and the write.
      if (isRecordNotFound(err)) {
        throw villaNotFound(ctx);
      }
      const foreignKey = foreignKeyConstraint(err);
      if (foreignKey?.includes("villaId")) {
        throw villaNotFound(ctx);
      }
      if (foreignKey?.includes("elecPhaseId")) {
        throw phaseNotFound(ctx);
      }
      throw err;
    }
  }

  private async runHooks(tx: Db, change: ProgressChange): Promise<void> {
    for (const hook of this.hooks) {
      await hook(tx, change);
    }
  }
}
