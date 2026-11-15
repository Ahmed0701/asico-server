import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { ForemanMissionSort } from "../dto/foreman-missions.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  notes: true,
  doneAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  villa: {
    select: {
      id: true,
      villaNumber: true,
      ownerName: true,
      block: true,
      plot: true,
      area: { select: { name: true } },
    },
  },
} satisfies Prisma.ForemanMissionSelect;

export type ForemanMissionRow = Prisma.ForemanMissionGetPayload<{ select: typeof select }>;

export type ForemanMissionFields = {
  villaId?: string;
  notes?: string;
  doneAt?: Date | null;
};

type ListParams = {
  search?: string | undefined;
  done?: boolean | undefined;
  villaId?: string | undefined;
  sort: ForemanMissionSort;
  skip: number;
  take: number;
};

// The search looks in the villa number, the villa's owner name and the notes.
function whereOf({
  search,
  done,
  villaId,
}: Pick<ListParams, "search" | "done" | "villaId">): Prisma.ForemanMissionWhereInput {
  const term = search ? escapeLike(search) : undefined;
  return {
    ...(done !== undefined && { doneAt: done ? { not: null } : null }),
    ...(villaId && { villaId }),
    ...(term && {
      OR: [
        { villa: { villaNumber: { contains: term, mode: "insensitive" } } },
        { villa: { ownerName: { contains: term, mode: "insensitive" } } },
        { notes: { contains: term, mode: "insensitive" } },
      ],
    }),
  };
}

// `id` breaks ties so pages never repeat or skip rows that share a value.
function orderByOf({
  field,
  direction,
}: ForemanMissionSort): Prisma.ForemanMissionOrderByWithRelationInput[] {
  switch (field) {
    case "villaNumber":
      return [{ villa: { villaNumber: direction } }, { id: "asc" }];
    case "doneAt":
      return [{ doneAt: { sort: direction, nulls: "last" } }, { id: "asc" }];
    default:
      return [{ createdAt: direction }, { id: "asc" }];
  }
}

export class ForemanMissionsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    { search, done, villaId, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: ForemanMissionRow[]; total: number }> {
    const where = whereOf({ search, done, villaId });
    const [rows, total] = await Promise.all([
      db.foremanMission.findMany({ where, select, orderBy: orderByOf(sort), skip, take }),
      db.foremanMission.count({ where }),
    ]);
    return { rows, total };
  }

  findById(id: string, db: Db = prisma): Promise<ForemanMissionRow | null> {
    return db.foremanMission.findUnique({ where: { id }, select });
  }

  async villaExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.villa.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  create(data: { villaId: string; notes: string }, db: Db = prisma): Promise<ForemanMissionRow> {
    return db.foremanMission.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such row).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "ForemanMission", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: ForemanMissionFields,
    db: Db = prisma,
  ): Promise<ForemanMissionRow | null> {
    const { count } = await db.foremanMission.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.foremanMission.findUnique({ where: { id }, select }) : null;
  }

  // False: the row was not at `version` any more. Its reminders go with it (ON DELETE CASCADE).
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.foremanMission.deleteMany({ where: { id, version } });
    return count === 1;
  }
}
