import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { env } from "../../../core/config/env.js";
import { logger } from "../../../core/config/logger.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t, type MessageKey } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { LocalDiskStorage } from "../../../core/storage/LocalDiskStorage.js";
import type { StorageService } from "../../../core/storage/StorageService.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { localDayOf } from "../../../shared/utils/deadline.js";
import { isRecordNotFound } from "../../../shared/utils/index.js";
import { NOTE_HEAD_BYTES } from "../../materials/dto/materials.dto.js";
import { noteFileName, noteTypeOf } from "../../materials/validators/materials.validators.js";
import {
  MAX_PAYMENT_FILES,
  PAYMENT_SORT_FIELDS,
  isPaymentSortField,
  type PaymentDto,
  type PaymentListResult,
  type PaymentSort,
  type PaymentStatusValue,
} from "../dto/payments.dto.js";
import { toPaymentDto, toPaymentSnapshot } from "../mapper/payments.mapper.js";
import {
  PaymentsRepository,
  type Db,
  type NewPaymentFile,
  type PaymentFields,
  type PaymentFileRow,
  type PaymentRow,
} from "../repository/payments.repository.js";
import type {
  CreatePaymentInput,
  ListPaymentsQuery,
  UpdatePaymentInput,
} from "../validators/payments.validators.js";

// The newest payment first.
const DEFAULT_SORT: PaymentSort = { field: "createdAt", direction: "desc" };
const ENTITY = "ContractorPayment";

const fail = (ctx: RequestContext, status: number, key: MessageKey, code: string) =>
  new AppError(status, t(ctx.locale, key), code);
const notFound = (ctx: RequestContext) => fail(ctx, 404, "errors.paymentNotFound", "PAYMENT_NOT_FOUND");
const contractorNotFound = (ctx: RequestContext) =>
  fail(ctx, 404, "errors.contractorNotFound", "CONTRACTOR_NOT_FOUND");
const villaNotFound = (ctx: RequestContext) => fail(ctx, 404, "errors.villaNotFound", "VILLA_NOT_FOUND");
const noFile = (ctx: RequestContext) =>
  fail(ctx, 404, "errors.paymentFileNotFound", "PAYMENT_FILE_NOT_FOUND");
const badFile = (ctx: RequestContext) => fail(ctx, 400, "errors.paymentFileType", "INVALID_FILE_TYPE");
const fileLimit = (ctx: RequestContext) => fail(ctx, 409, "errors.paymentFileLimit", "PAYMENT_FILE_LIMIT");

export type PaymentUpload = { tempPath: string; originalName: string };

const asDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

// The audit action of a change: marking it paid or back to pending alone has its own, anything else is an update.
function actionOf(input: UpdatePaymentInput): string {
  const onlyStatus = Object.keys(input).every((key) => key === "status" || key === "paidDate");
  let action = "payment.update";
  if (onlyStatus && input.status === "PAID") action = "payment.paid";
  if (onlyStatus && input.status === "PENDING") action = "payment.paid_undo";
  return action;
}

export class PaymentsService {
  constructor(
    private readonly repository = new PaymentsRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly storage: StorageService = new LocalDiskStorage(),
  ) {}

  // Today in APP_TIMEZONE, YYYY-MM-DD: the day a PAID payment without a date gets, and the overdue boundary.
  today(): string {
    return localDayOf(this.clock(), env.APP_TIMEZONE);
  }

  async list(query: ListPaymentsQuery): Promise<PaymentListResult> {
    const requested = parseSort(query.sort, PAYMENT_SORT_FIELDS);
    const sort: PaymentSort =
      requested && isPaymentSortField(requested.field)
        ? { field: requested.field, direction: requested.direction }
        : DEFAULT_SORT;
    const today = this.today();
    const filters = {
      search: query.search,
      status: query.status,
      contractorId: query.contractorId,
      villaId: query.villaId,
      overdueBefore: query.overdue ? asDay(today) : undefined,
    };
    const { page, limit, skip, take } = toPagination(query);
    const [{ rows, total }, totals] = await Promise.all([
      this.repository.list({ ...filters, sort, skip, take }),
      this.repository.totals(filters, asDay(today)),
    ]);
    return {
      items: rows.map((row) => toPaymentDto(row, today)),
      meta: buildMeta(page, limit, total),
      totals: {
        pendingMinor: Number(totals.pending),
        overdueMinor: Number(totals.overdue),
        paidMinor: Number(totals.paid),
      },
    };
  }

  async get(id: string, ctx: RequestContext): Promise<PaymentDto> {
    const row = await this.repository.findById(id);
    if (!row) throw notFound(ctx);
    return toPaymentDto(row, this.today());
  }

  async create(actor: Actor, input: CreatePaymentInput, ctx: RequestContext): Promise<PaymentDto> {
    const status: PaymentStatusValue = input.status ?? "PENDING";
    const created = await this.repository.transaction(async (tx) => {
      await this.assertParties(input.contractorId, input.villaId ?? null, ctx, tx);
      const row = await this.repository.create(
        {
          contractorId: input.contractorId,
          villaId: input.villaId ?? null,
          amountMinor: BigInt(input.amountMinor),
          status,
          dueDate: input.dueDate ?? null,
          paidDate: status === "PAID" ? (input.paidDate ?? asDay(this.today())) : null,
          method: input.method ?? null,
          reference: input.reference ?? null,
          notes: input.notes ?? null,
        },
        tx,
      );
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "payment.create",
          entity: ENTITY,
          entityId: row.id,
          after: toPaymentSnapshot(row),
        }),
      );
      return row;
    });
    return toPaymentDto(created, this.today());
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdatePaymentInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<PaymentDto> {
    try {
      const updated = await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        await this.assertParties(
          input.contractorId ?? target.contractor.id,
          input.villaId === undefined ? (target.villa?.id ?? null) : input.villaId,
          ctx,
          tx,
          { contractor: input.contractorId !== undefined, villa: input.villaId !== undefined },
        );
        const data: PaymentFields = {
          ...(input.contractorId !== undefined && { contractorId: input.contractorId }),
          ...(input.villaId !== undefined && { villaId: input.villaId }),
          ...(input.amountMinor !== undefined && { amountMinor: BigInt(input.amountMinor) }),
          ...(input.dueDate !== undefined && { dueDate: input.dueDate }),
          ...(input.method !== undefined && { method: input.method }),
          ...(input.reference !== undefined && { reference: input.reference }),
          ...(input.notes !== undefined && { notes: input.notes }),
        };
        // The paid date follows the status: kept (or set to today) while PAID, cleared when PENDING.
        const status = input.status ?? target.status;
        if (input.status !== undefined) data.status = input.status;
        if (status === "PENDING") {
          data.paidDate = null;
        } else if (input.paidDate !== undefined && input.paidDate !== null) {
          data.paidDate = input.paidDate;
        } else if (target.paidDate === null || input.paidDate === null) {
          data.paidDate = asDay(this.today());
        }
        const row = await this.repository.update(id, target.version, data, tx);
        if (!row) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: actionOf(input),
            entity: ENTITY,
            entityId: id,
            before: toPaymentSnapshot(target),
            after: toPaymentSnapshot(row),
          }),
        );
        return row;
      });
      return toPaymentDto(updated, this.today());
    } catch (err) {
      throw isRecordNotFound(err) ? notFound(ctx) : err;
    }
  }

  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    let keys: string[] = [];
    try {
      await this.repository.transaction(async (tx) => {
        const target = await this.lock(id, expectedVersion, ctx, tx);
        if (!(await this.repository.delete(id, target.version, tx))) {
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? target.version);
        }
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "payment.delete",
            entity: ENTITY,
            entityId: id,
            before: toPaymentSnapshot(target),
          }),
        );
        keys = target.files.map((file) => file.key);
      });
    } catch (err) {
      throw isRecordNotFound(err) ? notFound(ctx) : err;
    }
    for (const key of keys) await this.removeStored(key);
  }

  // ---- the receipt and invoice files ----

  // Where uploads are received (inside the storage root, so the final move is a rename).
  tempDir(): Promise<string> {
    return this.storage.tempDir();
  }

  async discardTemp(tempPath: string): Promise<void> {
    try {
      await this.storage.discardTemp(tempPath);
    } catch (err) {
      logger.warn({ err }, "could not remove a temporary upload file");
    }
  }

  // Adds receipt or invoice files, up to MAX_PAYMENT_FILES in all. Every file must really be a PDF, JPG or PNG, or none
  // is kept. The files are moved to their final keys before the transaction and deleted again if it fails. Whatever
  // happens, the temp files are gone afterwards.
  async uploadFiles(
    actor: Actor,
    id: string,
    uploads: PaymentUpload[],
    ctx: RequestContext,
  ): Promise<PaymentDto> {
    const stored: string[] = [];
    try {
      const existing = await this.repository.findById(id);
      if (!existing) throw notFound(ctx);
      if (existing.files.length + uploads.length > MAX_PAYMENT_FILES) throw fileLimit(ctx);
      const files: NewPaymentFile[] = [];
      for (const upload of uploads) {
        const { size, head } = await this.storage.inspectTemp(upload.tempPath, NOTE_HEAD_BYTES);
        const type = noteTypeOf(head);
        if (!type) throw badFile(ctx);
        files.push({
          key: `payments/${id}/${randomUUID()}.${type.extension}`,
          name: noteFileName(upload.originalName, type.extension),
          mime: type.mime,
          size,
          uploadedAt: this.clock(),
        });
      }
      for (const [index, upload] of uploads.entries()) {
        const file = files[index]!;
        await this.storage.moveIn(upload.tempPath, file.key);
        stored.push(file.key);
      }
      const row = await this.repository.transaction(async (tx) => {
        // The payment's row lock keeps two uploads from passing the limit together.
        if ((await this.repository.lockVersion(id, tx)) === null) throw notFound(ctx);
        if ((await this.repository.countFiles(id, tx)) + files.length > MAX_PAYMENT_FILES)
          throw fileLimit(ctx);
        await this.repository.addFiles(id, files, tx);
        const updated = await this.repository.findById(id, tx);
        if (!updated) throw notFound(ctx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "payment.file_upload",
            entity: ENTITY,
            entityId: id,
            after: {
              contractorName: updated.contractor.name,
              files: files.map((file) => ({ name: file.name, key: file.key })),
            },
          }),
        );
        return updated;
      });
      return toPaymentDto(row, this.today());
    } catch (err) {
      for (const key of stored) await this.removeStored(key);
      throw err;
    } finally {
      for (const upload of uploads) await this.discardTemp(upload.tempPath);
    }
  }

  // Removes one file: its row in the transaction, the file after the commit.
  async removeFile(actor: Actor, id: string, fileId: string, ctx: RequestContext): Promise<PaymentDto> {
    let key: string | null = null;
    const row = await this.repository.transaction(async (tx) => {
      if ((await this.repository.lockVersion(id, tx)) === null) throw notFound(ctx);
      const file = await this.repository.findFile(id, fileId, tx);
      if (!file) throw noFile(ctx);
      await this.repository.deleteFile(fileId, tx);
      const updated = await this.repository.findById(id, tx);
      if (!updated) throw notFound(ctx);
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "payment.file_delete",
          entity: ENTITY,
          entityId: id,
          before: { contractorName: updated.contractor.name, file: { name: file.name, key: file.key } },
        }),
      );
      key = file.key;
      return updated;
    });
    if (key) await this.removeStored(key);
    return toPaymentDto(row, this.today());
  }

  // One file, to send. A file of another payment, or a missing one, is a 404.
  async file(id: string, fileId: string, ctx: RequestContext): Promise<PaymentFileRow> {
    const file = await this.repository.findFile(id, fileId);
    if (!file) throw noFile(ctx);
    return file;
  }

  async openFile(key: string, ctx: RequestContext): Promise<{ stream: Readable; size: number }> {
    try {
      const size = await this.storage.size(key);
      return { stream: this.storage.createReadStream(key), size };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") throw noFile(ctx);
      throw err;
    }
  }

  // The contractor must exist, and the villa when one is given. `check` says which were sent (an edit that keeps them
  // does not look them up again).
  private async assertParties(
    contractorId: string,
    villaId: string | null,
    ctx: RequestContext,
    tx: Db,
    check: { contractor: boolean; villa: boolean } = { contractor: true, villa: true },
  ): Promise<void> {
    if (check.contractor && !(await this.repository.contractorExists(contractorId, tx))) {
      throw contractorNotFound(ctx);
    }
    if (check.villa && villaId !== null && !(await this.repository.villaExists(villaId, tx))) {
      throw villaNotFound(ctx);
    }
  }

  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<PaymentRow> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) throw notFound(ctx);
    assertVersion(ctx.locale, expectedVersion, version);
    const row = await this.repository.findById(id, tx);
    if (!row) throw notFound(ctx);
    return row;
  }

  private async removeStored(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err, key }, "could not remove a payment file from disk; it is now an orphan");
      }
    }
  }
}
