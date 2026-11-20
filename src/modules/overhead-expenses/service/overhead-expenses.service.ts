import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { logger } from "../../../core/config/logger.js";
import { assertVersion, versionConflict } from "../../../core/concurrency/version.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { LocalDiskStorage } from "../../../core/storage/LocalDiskStorage.js";
import type { StorageService } from "../../../core/storage/StorageService.js";
import { buildMeta, toPagination } from "../../../shared/query/pagination.js";
import { parseSort } from "../../../shared/query/sort.js";
import { toDay } from "../../../shared/utils/day.js";
import { foreignKeyConstraint } from "../../../shared/utils/index.js";
import { NOTE_HEAD_BYTES } from "../../materials/dto/materials.dto.js";
import { noteFileName, noteTypeOf } from "../../materials/validators/materials.validators.js";
import {
  EXPENSE_SORT_FIELDS,
  MAX_EXPENSE_FILES,
  type ExpenseSort,
  type ExpenseSortField,
  type ExpenseType,
  type OverheadExpenseDto,
  type OverheadExpenseListResult,
} from "../dto/overhead-expenses.dto.js";
import {
  OverheadExpensesRepository,
  type Db,
  type ExpenseFields,
  type ExpenseFileRow,
  type ExpenseRow,
  type NewExpenseFile,
} from "../repository/overhead-expenses.repository.js";
import type {
  CreateOverheadExpenseInput,
  ListOverheadExpensesQuery,
  UpdateOverheadExpenseInput,
} from "../validators/overhead-expenses.validators.js";

const ENTITY = "OverheadExpense";
const DEFAULT_SORT: ExpenseSort = { field: "expenseDate", direction: "desc" };

const notFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.expenseNotFound"), "OVERHEAD_EXPENSE_NOT_FOUND");
const villaNotFound = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.villaNotFound"), "VILLA_NOT_FOUND");
const noFile = (ctx: RequestContext) =>
  new AppError(404, t(ctx.locale, "errors.expenseFileNotFound"), "OVERHEAD_EXPENSE_FILE_NOT_FOUND");
const badFile = (ctx: RequestContext) =>
  new AppError(400, t(ctx.locale, "errors.expenseFileType"), "INVALID_FILE_TYPE");
const fileLimit = (ctx: RequestContext) =>
  new AppError(409, t(ctx.locale, "errors.expenseFileLimit"), "OVERHEAD_EXPENSE_FILE_LIMIT");

export type ExpenseUpload = { tempPath: string; originalName: string };

export function toOverheadExpenseDto(row: ExpenseRow): OverheadExpenseDto {
  return {
    id: row.id,
    villa: row.villa,
    // The database only holds one of EXPENSE_TYPES (a CHECK constraint).
    type: row.type as ExpenseType,
    description: row.description,
    amountMinor: Number(row.amountMinor),
    expenseDate: toDay(row.expenseDate),
    invoiceNumber: row.invoiceNumber,
    files: row.files.map((file) => ({
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
      uploadedAt: file.uploadedAt.toISOString(),
    })),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit entry records.
const snapshotOf = (row: ExpenseRow) => ({
  villaNumber: row.villa.villaNumber,
  type: row.type,
  description: row.description,
  amountMinor: Number(row.amountMinor),
  expenseDate: toDay(row.expenseDate),
  invoiceNumber: row.invoiceNumber,
});

export class OverheadExpensesService {
  constructor(
    private readonly repository = new OverheadExpensesRepository(),
    private readonly clock: () => Date = () => new Date(),
    private readonly storage: StorageService = new LocalDiskStorage(),
  ) {}

  async list(query: ListOverheadExpensesQuery): Promise<OverheadExpenseListResult> {
    const requested = parseSort(query.sort, EXPENSE_SORT_FIELDS);
    const sort: ExpenseSort = requested
      ? { field: requested.field as ExpenseSortField, direction: requested.direction }
      : DEFAULT_SORT;
    const { page, limit, skip, take } = toPagination(query);
    const { rows, total, amount } = await this.repository.list({
      search: query.search,
      villaId: query.villaId,
      type: query.type,
      sort,
      skip,
      take,
    });
    return {
      items: rows.map(toOverheadExpenseDto),
      meta: buildMeta(page, limit, total),
      totals: { count: total, amountMinor: Number(amount) },
    };
  }

  async get(id: string, ctx: RequestContext): Promise<OverheadExpenseDto> {
    const row = await this.repository.findById(id);
    if (!row) throw notFound(ctx);
    return toOverheadExpenseDto(row);
  }

  async create(
    actor: Actor,
    input: CreateOverheadExpenseInput,
    ctx: RequestContext,
  ): Promise<OverheadExpenseDto> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        if (!(await this.repository.villaExists(input.villaId, tx))) throw villaNotFound(ctx);
        const created = await this.repository.create(
          {
            villaId: input.villaId,
            type: input.type,
            description: input.description,
            amountMinor: BigInt(input.amountMinor),
            expenseDate: input.expenseDate,
            invoiceNumber: input.invoiceNumber ?? null,
          },
          tx,
        );
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "overhead_expense.create",
            entity: ENTITY,
            entityId: created.id,
            after: snapshotOf(created),
          }),
        );
        return created;
      });
      return toOverheadExpenseDto(row);
    } catch (err) {
      // The villa was deleted between the check and the insert: its foreign key stopped the insert.
      if (foreignKeyConstraint(err) !== undefined) throw villaNotFound(ctx);
      throw err;
    }
  }

  async update(
    actor: Actor,
    id: string,
    input: UpdateOverheadExpenseInput,
    ctx: RequestContext,
    expectedVersion?: number,
  ): Promise<OverheadExpenseDto> {
    try {
      const row = await this.repository.transaction(async (tx) => {
        const before = await this.lock(id, expectedVersion, ctx, tx);
        if (input.villaId !== undefined && !(await this.repository.villaExists(input.villaId, tx))) {
          throw villaNotFound(ctx);
        }
        const data: ExpenseFields = {
          ...(input.villaId !== undefined && { villaId: input.villaId }),
          ...(input.type !== undefined && { type: input.type }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.amountMinor !== undefined && { amountMinor: BigInt(input.amountMinor) }),
          ...(input.expenseDate !== undefined && { expenseDate: input.expenseDate }),
          ...(input.invoiceNumber !== undefined && { invoiceNumber: input.invoiceNumber }),
        };
        const after = await this.repository.update(id, before.version, data, tx);
        if (!after)
          throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? before.version);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "overhead_expense.update",
            entity: ENTITY,
            entityId: id,
            before: snapshotOf(before),
            after: snapshotOf(after),
          }),
        );
        return after;
      });
      return toOverheadExpenseDto(row);
    } catch (err) {
      if (foreignKeyConstraint(err) !== undefined) throw villaNotFound(ctx);
      throw err;
    }
  }

  // Deletes the expense and its files: the rows in the transaction, the files on disk after the commit.
  async remove(actor: Actor, id: string, ctx: RequestContext, expectedVersion?: number): Promise<void> {
    let keys: string[] = [];
    await this.repository.transaction(async (tx) => {
      const before = await this.lock(id, expectedVersion, ctx, tx);
      if (!(await this.repository.delete(id, before.version, tx))) {
        throw versionConflict(ctx.locale, (await this.repository.lockVersion(id, tx)) ?? before.version);
      }
      await audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: "overhead_expense.delete",
          entity: ENTITY,
          entityId: id,
          before: snapshotOf(before),
        }),
      );
      keys = before.files.map((file) => file.key);
    });
    for (const key of keys) await this.removeStored(key);
  }

  // ---- the invoice files ----

  // Where uploads are received (inside the storage root, so the final move is a rename).
  tempDir(): Promise<string> {
    return this.storage.tempDir();
  }

  // Adds invoice files (PDF, JPEG or PNG, told by their first bytes), up to MAX_EXPENSE_FILES in all. If one is not
  // such a file, none is kept. The files are moved to their final keys before the transaction and deleted again if it
  // fails. Whatever happens, the temp files are gone afterwards.
  async uploadFiles(
    actor: Actor,
    id: string,
    uploads: ExpenseUpload[],
    ctx: RequestContext,
  ): Promise<OverheadExpenseDto> {
    const stored: string[] = [];
    try {
      const existing = await this.repository.findById(id);
      if (!existing) throw notFound(ctx);
      if (existing.files.length + uploads.length > MAX_EXPENSE_FILES) throw fileLimit(ctx);
      const files: NewExpenseFile[] = [];
      for (const upload of uploads) {
        const { size, head } = await this.storage.inspectTemp(upload.tempPath, NOTE_HEAD_BYTES);
        const type = noteTypeOf(head);
        if (!type) throw badFile(ctx);
        files.push({
          key: `overhead-expenses/${id}/${randomUUID()}.${type.extension}`,
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
        // The row lock keeps two uploads from passing the limit together.
        if ((await this.repository.lockVersion(id, tx)) === null) throw notFound(ctx);
        if ((await this.repository.countFiles(id, tx)) + files.length > MAX_EXPENSE_FILES)
          throw fileLimit(ctx);
        await this.repository.addFiles(id, files, tx);
        const updated = await this.repository.findById(id, tx);
        if (!updated) throw notFound(ctx);
        await audit.record(
          tx,
          withMeta(ctx, {
            actorId: actor.id,
            action: "overhead_expense.file_upload",
            entity: ENTITY,
            entityId: id,
            after: {
              villaNumber: updated.villa.villaNumber,
              description: updated.description,
              files: files.map((file) => ({ name: file.name, key: file.key })),
            },
          }),
        );
        return updated;
      });
      return toOverheadExpenseDto(row);
    } catch (err) {
      for (const key of stored) await this.removeStored(key);
      throw err;
    } finally {
      for (const upload of uploads) await this.discardTemp(upload.tempPath);
    }
  }

  // Removes one file: its row in the transaction, the file after the commit.
  async removeFile(
    actor: Actor,
    id: string,
    fileId: string,
    ctx: RequestContext,
  ): Promise<OverheadExpenseDto> {
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
          action: "overhead_expense.file_delete",
          entity: ENTITY,
          entityId: id,
          before: {
            villaNumber: updated.villa.villaNumber,
            description: updated.description,
            file: { name: file.name, key: file.key },
          },
        }),
      );
      key = file.key;
      return updated;
    });
    if (key) await this.removeStored(key);
    return toOverheadExpenseDto(row);
  }

  // One file, to send. A file of another expense, or a missing one, is a 404.
  async file(id: string, fileId: string, ctx: RequestContext): Promise<ExpenseFileRow> {
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

  private async discardTemp(tempPath: string): Promise<void> {
    try {
      await this.storage.discardTemp(tempPath);
    } catch (err) {
      logger.warn({ err }, "could not remove a temporary upload file");
    }
  }

  private async removeStored(key: string): Promise<void> {
    try {
      await this.storage.delete(key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn({ err, key }, "could not remove an expense file from disk; it is now an orphan");
      }
    }
  }

  private async lock(
    id: string,
    expectedVersion: number | undefined,
    ctx: RequestContext,
    tx: Db,
  ): Promise<ExpenseRow> {
    const version = await this.repository.lockVersion(id, tx);
    if (version === null) throw notFound(ctx);
    assertVersion(ctx.locale, expectedVersion, version);
    const row = await this.repository.findById(id, tx);
    if (!row) throw notFound(ctx);
    return row;
  }
}
