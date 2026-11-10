import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import { MAX_OPTIONS, type CivilEngineerSort } from "../dto/civil-engineers.dto.js";

export type Db = Prisma.TransactionClient;

// `_count` makes Prisma count the related villas in the same query, so listing never asks once per row.
const select = {
  id: true,
  name: true,
  phone: true,
  email: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { villas: true } },
} satisfies Prisma.CivilEngineerSelect;

export type CivilEngineerRow = Prisma.CivilEngineerGetPayload<{ select: typeof select }>;

type ListParams = {
  search?: string | undefined;
  status?: PartyStatusValue | undefined;
  sort: CivilEngineerSort;
  skip: number;
  take: number;
};

// The search looks in the name, the phone and the email.
function whereOf(
  search: string | undefined,
  status: PartyStatusValue | undefined,
): Prisma.CivilEngineerWhereInput {
  const term = search ? escapeLike(search) : undefined;
  return {
    ...(status && { status }),
    ...(term && {
      OR: [
        { name: { contains: term, mode: "insensitive" } },
        { phone: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
      ],
    }),
  };
}

// `id` breaks ties so pages never repeat or skip rows that share a name or a timestamp.
function orderByOf({ field, direction }: CivilEngineerSort): Prisma.CivilEngineerOrderByWithRelationInput[] {
  return field === "name" ? [{ name: direction }, { id: "asc" }] : [{ createdAt: direction }, { id: "asc" }];
}

export class CivilEngineersRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    { search, status, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: CivilEngineerRow[]; total: number }> {
    const where = whereOf(search, status);
    const [rows, total] = await Promise.all([
      db.civilEngineer.findMany({ where, select, orderBy: orderByOf(sort), skip, take }),
      db.civilEngineer.count({ where }),
    ]);
    return { rows, total };
  }

  // The records a form can offer: the active ones.
  options(db: Db = prisma): Promise<{ id: string; name: string }[]> {
    return db.civilEngineer.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: MAX_OPTIONS,
    });
  }

  findById(id: string, db: Db = prisma): Promise<CivilEngineerRow | null> {
    return db.civilEngineer.findUnique({ where: { id }, select });
  }

  create(
    data: { name: string; phone: string; email: string | null; status: PartyStatusValue },
    db: Db = prisma,
  ): Promise<CivilEngineerRow> {
    return db.civilEngineer.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such engineer).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "CivilEngineer", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: { name?: string; phone?: string; email?: string | null; status?: PartyStatusValue },
    db: Db = prisma,
  ): Promise<CivilEngineerRow | null> {
    const { count } = await db.civilEngineer.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.civilEngineer.findUnique({ where: { id }, select }) : null;
  }

  // The foreign key from Villa is `onDelete: Restrict`, so this throws (P2003) if a villa still points here.
  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.civilEngineer.deleteMany({ where: { id, version } });
    return count === 1;
  }
}
