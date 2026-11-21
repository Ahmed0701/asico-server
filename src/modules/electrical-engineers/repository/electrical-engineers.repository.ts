import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import type { Prisma } from "../../../generated/prisma/client.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import { MAX_OPTIONS, type ElectricalEngineerSort } from "../dto/electrical-engineers.dto.js";

export type Db = Prisma.TransactionClient;

// `_count` makes Prisma count the engineer's villas (shown) and daily reports (only the delete guard looks at them) in the same
// query, so listing never asks once per row.
const select = {
  id: true,
  name: true,
  phone: true,
  email: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, name: true, email: true } },
  _count: { select: { villas: true, dailyReports: true } },
} satisfies Prisma.ElectricalEngineerSelect;

export type ElectricalEngineerRow = Prisma.ElectricalEngineerGetPayload<{ select: typeof select }>;

type ListParams = {
  search?: string | undefined;
  status?: PartyStatusValue | undefined;
  sort: ElectricalEngineerSort;
  skip: number;
  take: number;
};

// The search looks in the name, the phone and the email.
function whereOf(
  search: string | undefined,
  status: PartyStatusValue | undefined,
): Prisma.ElectricalEngineerWhereInput {
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
function orderByOf({
  field,
  direction,
}: ElectricalEngineerSort): Prisma.ElectricalEngineerOrderByWithRelationInput[] {
  return field === "name" ? [{ name: direction }, { id: "asc" }] : [{ createdAt: direction }, { id: "asc" }];
}

export class ElectricalEngineersRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    { search, status, sort, skip, take }: ListParams,
    db: Db = prisma,
  ): Promise<{ rows: ElectricalEngineerRow[]; total: number }> {
    const where = whereOf(search, status);
    const [rows, total] = await Promise.all([
      db.electricalEngineer.findMany({ where, select, orderBy: orderByOf(sort), skip, take }),
      db.electricalEngineer.count({ where }),
    ]);
    return { rows, total };
  }

  // The records a form can offer: the active ones.
  options(db: Db = prisma): Promise<{ id: string; name: string }[]> {
    return db.electricalEngineer.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: MAX_OPTIONS,
    });
  }

  // The users an engineer can be linked to: every one but the ADMINs (they always see everything).
  userOptions(db: Db = prisma): Promise<
    {
      id: string;
      name: string;
      email: string;
      isActive: boolean;
      electricalEngineer: { id: string; name: string } | null;
    }[]
  > {
    return db.user.findMany({
      where: { role: { not: "ADMIN" } },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        electricalEngineer: { select: { id: true, name: true } },
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: MAX_OPTIONS,
    });
  }

  // The user to link: its role and the engineer it is linked to now. Null: no such user.
  findUser(id: string, db: Db): Promise<{ role: string; electricalEngineer: { id: string } | null } | null> {
    return db.user.findUnique({
      where: { id },
      select: { role: true, electricalEngineer: { select: { id: true } } },
    });
  }

  // The numbers of the engineer's villas, for the audit entry of a transfer.
  async villaNumbersOf(id: string, db: Db): Promise<string[]> {
    const rows = await db.villa.findMany({
      where: { electricalEngineerId: id },
      select: { villaNumber: true },
    });
    return rows.map((row) => row.villaNumber);
  }

  // Gives every villa of one engineer to another, each villa's version bumped (it changed). Answers how many moved.
  async moveVillas(fromId: string, toId: string, db: Db): Promise<number> {
    const { count } = await db.villa.updateMany({
      where: { electricalEngineerId: fromId },
      data: { electricalEngineerId: toId, version: { increment: 1 } },
    });
    return count;
  }

  findById(id: string, db: Db = prisma): Promise<ElectricalEngineerRow | null> {
    return db.electricalEngineer.findUnique({ where: { id }, select });
  }

  create(
    data: {
      name: string;
      phone: string;
      email: string | null;
      status: PartyStatusValue;
      userId: string | null;
    },
    db: Db = prisma,
  ): Promise<ElectricalEngineerRow> {
    return db.electricalEngineer.create({ data, select });
  }

  // Locks the row for the rest of the transaction and returns its version (null: no such engineer).
  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "ElectricalEngineer", id);
  }

  // Compare-and-set: changes the row only if it is still at `version`, and bumps the version. Null: it was not.
  async update(
    id: string,
    version: number,
    data: {
      name?: string;
      phone?: string;
      email?: string | null;
      status?: PartyStatusValue;
      userId?: string | null;
    },
    db: Db = prisma,
  ): Promise<ElectricalEngineerRow | null> {
    const { count } = await db.electricalEngineer.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    return count === 1 ? db.electricalEngineer.findUnique({ where: { id }, select }) : null;
  }

  // False: the row was not at `version` any more.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.electricalEngineer.deleteMany({ where: { id, version } });
    return count === 1;
  }
}
