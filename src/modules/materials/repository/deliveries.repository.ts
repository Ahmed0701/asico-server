import { lockVersion } from "../../../core/concurrency/version.js";
import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { DeliverySort } from "../dto/materials.dto.js";

export type Db = Prisma.TransactionClient;

const select = {
  id: true,
  villaId: true,
  villa: { select: { id: true, villaNumber: true } },
  factoryId: true,
  factory: { select: { id: true, name: true, type: true } },
  lines: {
    select: {
      itemId: true,
      quantity: true,
      item: { select: { id: true, name: true, unit: true, type: true, sortOrder: true } },
    },
    orderBy: [{ item: { sortOrder: "asc" } }, { item: { name: "asc" } }],
  },
  noteNumber: true,
  deliveryDate: true,
  notes: {
    select: { id: true, key: true, name: true, mime: true, size: true, uploadedAt: true },
    orderBy: [{ uploadedAt: "asc" }, { id: "asc" }],
  },
  version: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MaterialDeliverySelect;

type DbRow = Prisma.MaterialDeliveryGetPayload<{ select: typeof select }>;

export type DeliveryLineRow = {
  itemId: string;
  quantity: number;
  item: { id: string; name: string; unit: string; type: FactoryTypeValue; sortOrder: number };
};

// A delivery as the module works with it: the quantities as numbers (they have at most two decimals).
export type DeliveryRow = Omit<DbRow, "lines"> & { lines: DeliveryLineRow[] };

const fromDb = (row: DbRow): DeliveryRow => ({
  ...row,
  lines: row.lines.map((line) => ({ ...line, quantity: Number(line.quantity) })),
});

export type LineInput = { itemId: string; quantity: number };

export type DeliveryFields = {
  villaId?: string;
  factoryId?: string;
  noteNumber?: string | null;
  deliveryDate?: Date;
};

export type NewDelivery = {
  villaId: string;
  factoryId: string;
  noteNumber: string | null;
  deliveryDate: Date;
  lines: LineInput[];
};

// A stored delivery note file.
export type NoteRow = { id: string; key: string; name: string; mime: string; size: number; uploadedAt: Date };
export type NewNote = Omit<NoteRow, "id">;

export type DeliveryFilters = {
  search?: string | undefined;
  villaId?: string | undefined;
  factoryId?: string | undefined;
  itemId?: string | undefined;
  type?: FactoryTypeValue | undefined;
  deliveryFrom?: Date | undefined;
  deliveryTo?: Date | undefined;
  hasNote?: boolean | undefined;
};

export type ImportCatalog = {
  factories: { id: string; name: string; type: FactoryTypeValue }[];
  items: { id: string; name: string; type: FactoryTypeValue }[];
};

// A villa's deliveries per factory type, and how many of them have their delivery note.
export type DeliveryCountRow = { type: FactoryTypeValue; deliveries: number; withNote: number };

function whereOf(f: DeliveryFilters): Prisma.MaterialDeliveryWhereInput {
  const term = f.search ? escapeLike(f.search) : undefined;
  return {
    ...(f.villaId && { villaId: f.villaId }),
    ...(f.factoryId && { factoryId: f.factoryId }),
    ...(f.itemId && { lines: { some: { itemId: f.itemId } } }),
    ...(f.type && { factory: { type: f.type } }),
    ...((f.deliveryFrom || f.deliveryTo) && {
      deliveryDate: {
        ...(f.deliveryFrom && { gte: f.deliveryFrom }),
        ...(f.deliveryTo && { lte: f.deliveryTo }),
      },
    }),
    ...(f.hasNote !== undefined && { notes: f.hasNote ? { some: {} } : { none: {} } }),
    ...(term && {
      OR: [
        { lines: { some: { item: { name: { contains: term, mode: "insensitive" } } } } },
        { noteNumber: { contains: term, mode: "insensitive" } },
        { factory: { name: { contains: term, mode: "insensitive" } } },
        { villa: { villaNumber: { contains: term, mode: "insensitive" } } },
      ],
    }),
  };
}

function orderByOf({ field, direction }: DeliverySort): Prisma.MaterialDeliveryOrderByWithRelationInput[] {
  return field === "createdAt"
    ? [{ createdAt: direction }, { id: "asc" }]
    : [{ deliveryDate: direction }, { createdAt: "desc" }, { id: "asc" }];
}

export class DeliveriesRepository {
  transaction<T>(work: (tx: Db) => Promise<T>, options?: { timeout?: number }): Promise<T> {
    return prisma.$transaction(work, options);
  }

  async userExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.user.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  // What an import checks its rows against: the villas by number, the factories and the materials by name.
  importVillas(db: Db = prisma): Promise<{ id: string; villaNumber: string }[]> {
    return db.villa.findMany({ select: { id: true, villaNumber: true } });
  }

  async importCatalog(db: Db = prisma): Promise<ImportCatalog> {
    const [factories, items] = await Promise.all([
      db.factory.findMany({ select: { id: true, name: true, type: true } }),
      db.materialItem.findMany({ select: { id: true, name: true, type: true } }),
    ]);
    return { factories, items };
  }

  // LOCK ORDER, FIRST: the villas an import writes to, shared and in the order of their ids. Returns the ids that still exist.
  async lockVillasShared(villaIds: readonly string[], db: Db): Promise<Set<string>> {
    if (villaIds.length === 0) return new Set();
    const rows = await db.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT "id" FROM "Villa" WHERE "id" IN (${Prisma.join([...villaIds])}) ORDER BY "id" FOR SHARE`,
    );
    return new Set(rows.map((row) => row.id));
  }

  async list(
    params: DeliveryFilters & { sort: DeliverySort; skip: number; take: number },
    db: Db = prisma,
  ): Promise<{ rows: DeliveryRow[]; total: number }> {
    const where = whereOf(params);
    const [rows, total] = await Promise.all([
      db.materialDelivery.findMany({
        where,
        select,
        orderBy: orderByOf(params.sort),
        skip: params.skip,
        take: params.take,
      }),
      db.materialDelivery.count({ where }),
    ]);
    return { rows: rows.map(fromDb), total };
  }

  async findById(id: string, db: Db = prisma): Promise<DeliveryRow | null> {
    const row = await db.materialDelivery.findUnique({ where: { id }, select });
    return row ? fromDb(row) : null;
  }

  async villaExists(id: string, db: Db = prisma): Promise<boolean> {
    return (await db.villa.findUnique({ where: { id }, select: { id: true } })) !== null;
  }

  // The factory's type, or null when there is no such factory.
  async factoryType(id: string, db: Db = prisma): Promise<FactoryTypeValue | null> {
    return (await db.factory.findUnique({ where: { id }, select: { type: true } }))?.type ?? null;
  }

  // The type of each catalog item among these ids that exists.
  async itemTypes(ids: string[], db: Db = prisma): Promise<Map<string, FactoryTypeValue>> {
    const rows = await db.materialItem.findMany({
      where: { id: { in: ids } },
      select: { id: true, type: true },
    });
    return new Map(rows.map((row) => [row.id, row.type]));
  }

  async create(data: NewDelivery, db: Db = prisma): Promise<DeliveryRow> {
    const { lines, ...fields } = data;
    return fromDb(
      await db.materialDelivery.create({ data: { ...fields, lines: { create: lines } }, select }),
    );
  }

  lockVersion(id: string, db: Db): Promise<number | null> {
    return lockVersion(db, "MaterialDelivery", id);
  }

  // Compare-and-set on the version; `lines`, when given, replaces all the lines. Null: the row was not at `version` any more.
  async update(
    id: string,
    version: number,
    data: DeliveryFields,
    lines: LineInput[] | undefined,
    db: Db = prisma,
  ): Promise<DeliveryRow | null> {
    const { count } = await db.materialDelivery.updateMany({
      where: { id, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (count !== 1) return null;
    if (lines) {
      await db.materialDeliveryLine.deleteMany({ where: { deliveryId: id } });
      await db.materialDeliveryLine.createMany({ data: lines.map((line) => ({ ...line, deliveryId: id })) });
    }
    return this.findById(id, db);
  }

  // Adds delivery note files to a delivery.
  async addNotes(deliveryId: string, notes: NewNote[], db: Db = prisma): Promise<void> {
    await db.materialDeliveryNote.createMany({ data: notes.map((note) => ({ ...note, deliveryId })) });
  }

  // The delivery note file, only when it belongs to this delivery.
  findNote(deliveryId: string, noteId: string, db: Db = prisma): Promise<NoteRow | null> {
    return db.materialDeliveryNote.findFirst({
      where: { id: noteId, deliveryId },
      select: { id: true, key: true, name: true, mime: true, size: true, uploadedAt: true },
    });
  }

  async deleteNote(noteId: string, db: Db = prisma): Promise<boolean> {
    const { count } = await db.materialDeliveryNote.deleteMany({ where: { id: noteId } });
    return count === 1;
  }

  countNotes(deliveryId: string, db: Db = prisma): Promise<number> {
    return db.materialDeliveryNote.count({ where: { deliveryId } });
  }

  // The lines and the delivery note rows go with it (ON DELETE CASCADE); the files are the caller's to remove.
  async delete(id: string, version: number, db: Db = prisma): Promise<boolean> {
    const { count } = await db.materialDelivery.deleteMany({ where: { id, version } });
    return count === 1;
  }

  async countsOfVilla(villaId: string, db: Db = prisma): Promise<DeliveryCountRow[]> {
    return db.$queryRaw<DeliveryCountRow[]>(Prisma.sql`
      SELECT f."type"::text AS "type", count(*)::int AS "deliveries",
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "MaterialDeliveryNote" n WHERE n."deliveryId" = d."id"))::int AS "withNote"
      FROM "MaterialDelivery" d JOIN "Factory" f ON f."id" = d."factoryId"
      WHERE d."villaId" = ${villaId}
      GROUP BY f."type"`);
  }
}
