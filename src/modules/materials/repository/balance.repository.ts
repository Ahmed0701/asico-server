import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { BalanceStatus } from "../dto/materials.dto.js";

export type Db = Prisma.TransactionClient;

// One material of one villa: what it needs (its own quantity, else the catalog's), what came, and the deliveries that brought it.
export type BalanceRow = {
  villaId: string;
  villaNumber: string;
  itemId: string;
  name: string;
  unit: string;
  type: FactoryTypeValue;
  required: number;
  custom: boolean;
  delivered: number;
  deliveries: number;
  withNote: number;
};

export type BalanceTotalRow = {
  itemId: string;
  name: string;
  unit: string;
  type: FactoryTypeValue;
  balance: number;
  villas: number;
};

export type BalanceFilters = {
  search?: string | undefined;
  villaId?: string | undefined;
  itemId?: string | undefined;
  type?: FactoryTypeValue | undefined;
  status?: BalanceStatus | undefined;
};

type RawRow = Omit<BalanceRow, "required" | "delivered"> & { required: string; delivered: string };

// Every villa against every catalog item: the requirement (the villa's own row, else the item's requiredPerVilla) next to what its
// deliveries brought. Only the pairs that need something or received something are rows.
const PAIRS = Prisma.sql`
  WITH delivered AS (
    SELECT d."villaId", l."itemId", sum(l."quantity") AS "delivered",
           count(*)::int AS "deliveries",
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "MaterialDeliveryNote" n WHERE n."deliveryId" = d."id"))::int AS "withNote"
    FROM "MaterialDeliveryLine" l JOIN "MaterialDelivery" d ON d."id" = l."deliveryId"
    GROUP BY d."villaId", l."itemId"
  ),
  pairs AS (
    SELECT v."id" AS "villaId", v."villaNumber", i."id" AS "itemId", i."name", i."unit", i."type", i."sortOrder",
           COALESCE(r."quantity", i."requiredPerVilla") AS "required",
           (r."quantity" IS NOT NULL) AS "custom",
           COALESCE(dl."delivered", 0) AS "delivered",
           COALESCE(dl."deliveries", 0) AS "deliveries",
           COALESCE(dl."withNote", 0) AS "withNote"
    FROM "Villa" v
    CROSS JOIN "MaterialItem" i
    LEFT JOIN "VillaMaterialRequirement" r ON r."villaId" = v."id" AND r."itemId" = i."id"
    LEFT JOIN delivered dl ON dl."villaId" = v."id" AND dl."itemId" = i."id"
  )`;

function whereOf(f: BalanceFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`(p."required" > 0 OR p."delivered" > 0)`];
  if (f.villaId) conditions.push(Prisma.sql`p."villaId" = ${f.villaId}`);
  if (f.itemId) conditions.push(Prisma.sql`p."itemId" = ${f.itemId}`);
  if (f.type) conditions.push(Prisma.sql`p."type" = ${f.type}::"FactoryType"`);
  if (f.search) conditions.push(Prisma.sql`p."villaNumber" ILIKE ${`%${escapeLike(f.search)}%`}`);
  if (f.status === "PENDING") conditions.push(Prisma.sql`p."required" > p."delivered"`);
  if (f.status === "COMPLETE") conditions.push(Prisma.sql`p."required" = p."delivered"`);
  if (f.status === "OVER") conditions.push(Prisma.sql`p."required" < p."delivered"`);
  return Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
}

const toRow = (row: RawRow): BalanceRow => ({
  ...row,
  required: Number(row.required),
  delivered: Number(row.delivered),
});

export class BalanceRepository {
  async list(
    params: BalanceFilters & { skip: number; take: number },
    db: Db = prisma,
  ): Promise<{ rows: BalanceRow[]; total: number; totals: BalanceTotalRow[] }> {
    const where = whereOf(params);
    const [rows, count, totals] = await Promise.all([
      db.$queryRaw<RawRow[]>(Prisma.sql`${PAIRS}
        SELECT p."villaId", p."villaNumber", p."itemId", p."name", p."unit", p."type"::text AS "type",
               p."required"::text AS "required", p."custom", p."delivered"::text AS "delivered", p."deliveries", p."withNote"
        FROM pairs p ${where}
        ORDER BY p."villaNumber", p."type", p."sortOrder", p."name", p."itemId"
        LIMIT ${params.take} OFFSET ${params.skip}`),
      db.$queryRaw<{ total: number }[]>(
        Prisma.sql`${PAIRS} SELECT count(*)::int AS "total" FROM pairs p ${where}`,
      ),
      db.$queryRaw<(Omit<BalanceTotalRow, "balance"> & { balance: string })[]>(Prisma.sql`${PAIRS}
        SELECT p."itemId", p."name", p."unit", p."type"::text AS "type",
               sum(GREATEST(p."required" - p."delivered", 0))::text AS "balance",
               count(*) FILTER (WHERE p."required" > p."delivered")::int AS "villas"
        FROM pairs p ${where}
        GROUP BY p."itemId", p."name", p."unit", p."type", p."sortOrder"
        HAVING sum(GREATEST(p."required" - p."delivered", 0)) > 0
        ORDER BY p."type", p."sortOrder", p."name"`),
    ]);
    return {
      rows: rows.map(toRow),
      total: count[0]?.total ?? 0,
      totals: totals.map((row) => ({ ...row, balance: Number(row.balance) })),
    };
  }

  // Every material of one villa (it is at most the size of the catalog).
  async ofVilla(villaId: string, db: Db = prisma): Promise<BalanceRow[]> {
    const rows = await db.$queryRaw<RawRow[]>(Prisma.sql`${PAIRS}
      SELECT p."villaId", p."villaNumber", p."itemId", p."name", p."unit", p."type"::text AS "type",
             p."required"::text AS "required", p."custom", p."delivered"::text AS "delivered", p."deliveries", p."withNote"
      FROM pairs p ${whereOf({ villaId })}
      ORDER BY p."type", p."sortOrder", p."name"`);
    return rows.map(toRow);
  }

  // Sets a villa's own quantities: a number keeps (or replaces) its row, null removes it, so the catalog's quantity applies again.
  async setRequirements(
    villaId: string,
    items: { itemId: string; quantity: number | null }[],
    db: Db = prisma,
  ): Promise<void> {
    for (const { itemId, quantity } of items) {
      if (quantity === null) {
        await db.villaMaterialRequirement.deleteMany({ where: { villaId, itemId } });
      } else {
        await db.villaMaterialRequirement.upsert({
          where: { villaId_itemId: { villaId, itemId } },
          create: { villaId, itemId, quantity },
          update: { quantity },
        });
      }
    }
  }
}
