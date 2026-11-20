import { prisma } from "../../../core/database/prisma.js";
import { Prisma } from "../../../generated/prisma/client.js";
import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import { escapeLike } from "../../../shared/query/where.js";
import type { MaterialOrderSortField, MaterialOrderStatus } from "../dto/material-orders.dto.js";

export type Db = Prisma.TransactionClient;

export type MaterialOrderRow = {
  villaId: string;
  villaNumber: string;
  type: FactoryTypeValue;
  factoryId: string | null;
  factoryName: string | null;
  mrDate: Date | null;
  poDate: Date | null;
  dueDate: Date | null;
  deliveryMrDate: Date | null;
  deliveryPoDate: Date | null;
  lastDeliveryDate: Date | null;
  requiredItems: number;
  completeItems: number;
  status: MaterialOrderStatus;
  overdue: boolean;
};

export type MaterialOrderFilters = {
  search?: string | undefined;
  villaId?: string | undefined;
  type?: FactoryTypeValue | undefined;
  status?: MaterialOrderStatus | undefined;
  overdue?: boolean | undefined;
};

// Every villa twice, once per factory type: its entered dates, the dates on its delivery notes, and how many of the
// materials of that type it needs came in full (its own quantity, else the catalog's, against what its deliveries
// brought). `today` decides what is overdue.
const ROWS = (today: Date) => Prisma.sql`
  WITH delivered AS (
    SELECT d."villaId", l."itemId", sum(l."quantity") AS "delivered"
    FROM "MaterialDeliveryLine" l JOIN "MaterialDelivery" d ON d."id" = l."deliveryId"
    GROUP BY d."villaId", l."itemId"
  ),
  pairs AS (
    SELECT v."id" AS "villaId", i."type",
           COALESCE(r."quantity", i."requiredPerVilla") AS "required",
           COALESCE(dl."delivered", 0) AS "delivered"
    FROM "Villa" v
    CROSS JOIN "MaterialItem" i
    LEFT JOIN "VillaMaterialRequirement" r ON r."villaId" = v."id" AND r."itemId" = i."id"
    LEFT JOIN delivered dl ON dl."villaId" = v."id" AND dl."itemId" = i."id"
  ),
  agg AS (
    SELECT p."villaId", p."type",
           count(*) FILTER (WHERE p."required" > 0)::int AS "needed",
           count(*) FILTER (WHERE p."required" > 0 AND p."delivered" >= p."required")::int AS "complete",
           COALESCE(sum(p."delivered"), 0) AS "deliveredSum"
    FROM pairs p
    GROUP BY p."villaId", p."type"
  ),
  notes AS (
    SELECT d."villaId", f."type", min(d."mrDate") AS "mr", min(d."poDate") AS "po", max(d."deliveryDate") AS "last"
    FROM "MaterialDelivery" d JOIN "Factory" f ON f."id" = d."factoryId"
    GROUP BY d."villaId", f."type"
  ),
  rows AS (
    SELECT v."id" AS "villaId", v."villaNumber", t."type",
           CASE WHEN t."type" = 'SWITCHGEAR' THEN v."switchgearFactoryId" ELSE v."cableFactoryId" END AS "factoryId",
           o."mrDate", o."poDate", o."dueDate",
           n."mr" AS "deliveryMrDate", n."po" AS "deliveryPoDate", n."last" AS "lastDeliveryDate",
           COALESCE(a."needed", 0) AS "requiredItems", COALESCE(a."complete", 0) AS "completeItems",
           CASE
             WHEN COALESCE(a."needed", 0) = 0 THEN 'NOT_REQUIRED'
             WHEN a."complete" = a."needed" THEN 'DELIVERED'
             WHEN a."deliveredSum" > 0 THEN 'PARTIAL'
             ELSE 'NOT_DELIVERED'
           END AS "status"
    FROM "Villa" v
    CROSS JOIN (VALUES ('SWITCHGEAR'::"FactoryType"), ('CABLE'::"FactoryType")) AS t("type")
    LEFT JOIN agg a ON a."villaId" = v."id" AND a."type" = t."type"
    LEFT JOIN notes n ON n."villaId" = v."id" AND n."type" = t."type"
    LEFT JOIN "VillaMaterialOrder" o ON o."villaId" = v."id" AND o."type" = t."type"
  ),
  shown AS (
    SELECT r.*, f."name" AS "factoryName",
           (r."dueDate" IS NOT NULL AND r."dueDate" < ${today}::date
             AND r."status" IN ('PARTIAL', 'NOT_DELIVERED')) AS "overdue"
    FROM rows r LEFT JOIN "Factory" f ON f."id" = r."factoryId"
  )`;

function whereOf(f: MaterialOrderFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = [Prisma.sql`TRUE`];
  if (f.villaId) conditions.push(Prisma.sql`s."villaId" = ${f.villaId}`);
  if (f.type) conditions.push(Prisma.sql`s."type" = ${f.type}::"FactoryType"`);
  if (f.status) conditions.push(Prisma.sql`s."status" = ${f.status}`);
  if (f.overdue !== undefined) conditions.push(Prisma.sql`s."overdue" = ${f.overdue}`);
  if (f.search) conditions.push(Prisma.sql`s."villaNumber" ILIKE ${`%${escapeLike(f.search)}%`}`);
  return Prisma.sql`WHERE ${Prisma.join(conditions, " AND ")}`;
}

function orderOf(field: MaterialOrderSortField, direction: "asc" | "desc"): Prisma.Sql {
  const dir = direction === "desc" ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  if (field === "dueDate") {
    return Prisma.sql`ORDER BY s."dueDate" ${dir} NULLS LAST, s."villaNumber", s."type"`;
  }
  return Prisma.sql`ORDER BY s."villaNumber" ${dir}, s."type"`;
}

type RawRow = Omit<MaterialOrderRow, "type"> & { type: string };

export class MaterialOrdersRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return prisma.$transaction(work);
  }

  async list(
    params: MaterialOrderFilters & {
      today: Date;
      sort: { field: MaterialOrderSortField; direction: "asc" | "desc" };
      skip: number;
      take: number;
    },
    db: Db = prisma,
  ): Promise<{
    rows: MaterialOrderRow[];
    total: number;
    summary: { total: number; delivered: number; partial: number; notDelivered: number; overdue: number };
  }> {
    const base = ROWS(params.today);
    const where = whereOf(params);
    const [rows, summary] = await Promise.all([
      db.$queryRaw<RawRow[]>(Prisma.sql`${base}
        SELECT s."villaId", s."villaNumber", s."type"::text AS "type", s."factoryId", s."factoryName",
               s."mrDate", s."poDate", s."dueDate", s."deliveryMrDate", s."deliveryPoDate", s."lastDeliveryDate",
               s."requiredItems", s."completeItems", s."status", s."overdue"
        FROM shown s ${where}
        ${orderOf(params.sort.field, params.sort.direction)}
        LIMIT ${params.take} OFFSET ${params.skip}`),
      db.$queryRaw<
        { total: number; delivered: number; partial: number; notDelivered: number; overdue: number }[]
      >(Prisma.sql`${base}
        SELECT count(*)::int AS "total",
               count(*) FILTER (WHERE s."status" = 'DELIVERED')::int AS "delivered",
               count(*) FILTER (WHERE s."status" = 'PARTIAL')::int AS "partial",
               count(*) FILTER (WHERE s."status" = 'NOT_DELIVERED')::int AS "notDelivered",
               count(*) FILTER (WHERE s."overdue")::int AS "overdue"
        FROM shown s ${where}`),
    ]);
    const counts = summary[0] ?? { total: 0, delivered: 0, partial: 0, notDelivered: 0, overdue: 0 };
    return {
      rows: rows.map((row) => ({ ...row, type: row.type as FactoryTypeValue })),
      total: counts.total,
      summary: counts,
    };
  }

  // The villa's number; null: no such villa.
  async villaNumber(villaId: string, db: Db): Promise<string | null> {
    const villa = await db.villa.findUnique({ where: { id: villaId }, select: { villaNumber: true } });
    return villa?.villaNumber ?? null;
  }

  findOrder(villaId: string, type: FactoryTypeValue, db: Db) {
    return db.villaMaterialOrder.findUnique({
      where: { villaId_type: { villaId, type } },
      select: { mrDate: true, poDate: true, dueDate: true },
    });
  }

  async saveOrder(
    villaId: string,
    type: FactoryTypeValue,
    dates: { mrDate: Date | null; poDate: Date | null; dueDate: Date | null },
    db: Db,
  ): Promise<void> {
    await db.villaMaterialOrder.upsert({
      where: { villaId_type: { villaId, type } },
      create: { villaId, type, ...dates },
      update: dates,
    });
  }
}
