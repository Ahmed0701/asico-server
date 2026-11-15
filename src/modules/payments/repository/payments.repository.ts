import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { PaymentMethodValue, PaymentSort, PaymentStatusValue } from "../dto/payments.dto.js";

export type Db = Prisma.TransactionClient;

const fileSelect = { id: true, key: true, name: true, mime: true, size: true, uploadedAt: true } as const;

const select = {
  id: true,
  amountMinor: true,
  status: true,
  dueDate: true,
  paidDate: true,
  method: true,
  reference: true,
  notes: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  contractor: { select: { id: true, name: true } },
  villa: {
    select: { id: true, villaNumber: true, block: true, plot: true, area: { select: { name: true } } },
  },
  files: { select: fileSelect, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }] },
} satisfies Prisma.ContractorPaymentSelect;

export type PaymentRow = Prisma.ContractorPaymentGetPayload<{ select: typeof select }>;
export type PaymentFileRow = PaymentRow["files"][number];

export type PaymentFields = {
  contractorId?: string;
  villaId?: string | null;
  amountMinor?: bigint;
  status?: PaymentStatusValue;
  dueDate?: Date | null;
  paidDate?: Date | null;
  method?: PaymentMethodValue | null;
  reference?: string | null;
  notes?: string | null;
};

export type NewPayment = Required<Pick<PaymentFields, "contractorId" | "amountMinor" | "status">> &
  Omit<PaymentFields, "contractorId" | "amountMinor" | "status">;

export type NewPaymentFile = { key: string; name: string; mime: string; size: number; uploadedAt: Date };

export type PaymentFilters = {
  search?: string | undefined;
  status?: PaymentStatusValue | undefined;
  contractorId?: string | undefined;
  villaId?: string | undefined;
  // The day (APP_TIMEZONE) before which a pending payment's due date makes it overdue; set to keep only those.
  overdueBefore?: Date | undefined;
};

type ListParams = PaymentFilters & { sort: PaymentSort; skip: number; take: number };

// The search looks in the reference, the notes, the contractor's name and the villa number.
function whereOf({
  search,
  status,
  contractorId,
  villaId,
  overdueBefore,
}: PaymentFilters): Prisma.ContractorPaymentWhereInput {
  const term = search ? escapeLike(search) : undefined;
  return {
    ...(status && { status }),
    ...(contractorId && { contractorId }),
    ...(villaId && { villaId }),
    ...(overdueBefore && { status: "PENDING", dueDate: { lt: overdueBefore } }),
    ...(term && {
      OR: [
        { reference: { contains: term, mode: "insensitive" } },
        { notes: { contains: term, mode: "insensitive" } },
        { contractor: { name: { contains: term, mode: "insensitive" } } },
        { villa: { villaNumber: { contains: term, mode: "insensitive" } } },
      ],
    }),
  };
}

// `id` breaks ties so pages never repeat or skip rows that share a value. Payments with no date go last.
function orderByOf({ field, direction }: PaymentSort): Prisma.ContractorPaymentOrderByWithRelationInput[] {
  switch (field) {
    case "dueDate":
      return [{ dueDate: { sort: direction, nulls: "last" } }, { id: "asc" }];
    case "paidDate":
      return [{ paidDate: { sort: direction, nulls: "last" } }, { id: "asc" }];
    case "amount":
      return [{ amountMinor: direction }, { id: "asc" }];
    case "villaNumber":
      return [{ villa: { villaNumber: direction } }, { id: "asc" }];
    default:
      return [{ createdAt: direction }, { id: "asc" }];
  }
}

export class PaymentsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async list(
    { sort, skip, take, ...filters }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: PaymentRow[]; total: number }> {
    const where = whereOf(filters);
    const [rows, total] = await Promise.all([
      db.contractorPayment.findMany({ where, select, orderBy: orderByOf(sort), skip, take }),
      db.contractorPayment.count({ where }),
    ]);
    return { rows, total };
  }

  // The amounts of the payments the filters match: pending (and of those, overdue before `today`) and paid.
  async totals(
    filters: PaymentFilters,
    today: Date,
    db: Db = prisma,
  ): Promise<{ pending: bigint; overdue: bigint; paid: bigint }> {
    const where = whereOf(filters);
    const [byStatus, overdue] = await Promise.all([
      db.contractorPayment.groupBy({ by: ["status"], where, _sum: { amountMinor: true } }),
      db.contractorPayment.aggregate({
        where: { AND: [where, { status: "PENDING", dueDate: { lt: today } }] },
        _sum: { amountMinor: true },
      }),
    ]);
    const sumOf = (value: PaymentStatusValue) =>
      byStatus.find((row) => row.status === value)?._sum.amountMinor ?? 0n;
    return { pending: sumOf("PENDING"), overdue: overdue._sum.amountMinor ?? 0n, paid: sumOf("PAID") };
  }

  findById(id: string, db: Db = prisma): Promise<PaymentRow | null> {
    return db.contractorPayment.findUnique({ where: { id }, select });
  }

  async contractorExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.contractor.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  async villaExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.villa.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  create(data: NewPayment, db: Db = prisma): Promise<PaymentRow> {
    return db.contractorPayment.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "ContractorPayment", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: PaymentFields,
    db: Db = prisma,
  ): Promise<PaymentRow | null> {
    const { count } = await db.contractorPayment.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.contractorPayment.findUnique({ where: { id }, select }) : null;
  }

  // False: the row was not at `version` any more. Its files' rows and reminders go with it (ON DELETE CASCADE).
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.contractorPayment.deleteMany({ where: { id, version } });
    return count === 1;
  }

  // ---- the receipt and invoice files ----

  async addFiles(paymentId: string, files: readonly NewPaymentFile[], db: Db): Promise<void> {
    await db.contractorPaymentFile.createMany({ data: files.map((file) => ({ ...file, paymentId })) });
  }

  countFiles(paymentId: string, db: Db): Promise<number> {
    return db.contractorPaymentFile.count({ where: { paymentId } });
  }

  findFile(paymentId: string, fileId: string, db: Db = prisma): Promise<PaymentFileRow | null> {
    return db.contractorPaymentFile.findFirst({ where: { id: fileId, paymentId }, select: fileSelect });
  }

  async deleteFile(fileId: string, db: Db): Promise<void> {
    await db.contractorPaymentFile.delete({ where: { id: fileId } });
  }

  // ---- the import ----

  importContractors(db: Db = prisma): Promise<{ id: string; name: string }[]> {
    return db.contractor.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });
  }

  importVillas(db: Db = prisma): Promise<{ id: string; villaNumber: string }[]> {
    return db.villa.findMany({ select: { id: true, villaNumber: true }, orderBy: { villaNumber: "asc" } });
  }
}
