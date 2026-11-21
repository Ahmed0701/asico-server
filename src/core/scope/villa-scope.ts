import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma } from "../../generated/prisma/client.js";

// The villas a request may see. A user linked to an electrical engineer (and not an ADMIN) sees only the villas of
// that engineer, everywhere: lists, counts, pages, pickers, and every record that hangs off a villa. Anyone else is not
// limited. The scope is set once, by `auth`, for the rest of the request; background jobs run without one.
export type VillaScope = { engineerId: string };

const storage = new AsyncLocalStorage<VillaScope>();

export function runWithVillaScope<T>(scope: VillaScope | undefined, work: () => T): T {
  return scope ? storage.run(scope, work) : work();
}

// Work that must see every villa whoever asked (a cache shared by every request): run outside the scope.
export function withoutVillaScope<T>(work: () => T): T {
  return storage.exit(work);
}

export function currentVillaScope(): VillaScope | undefined {
  return storage.getStore();
}

// For raw SQL: a condition on a "Villa" row under `alias`, TRUE when the request is not limited.
export function villaScopeSql(alias = "v"): Prisma.Sql {
  const scope = currentVillaScope();
  if (!scope) return Prisma.sql`TRUE`;
  return Prisma.sql`${Prisma.raw(`"${alias}"."electricalEngineerId"`)} = ${scope.engineerId}`;
}

// The same as a list to push onto a query's conditions: empty when the request is not limited.
export function villaScopeConditions(alias = "v"): Prisma.Sql[] {
  return currentVillaScope() ? [villaScopeSql(alias)] : [];
}

// For raw SQL on a table without the villa joined: a condition on its villa id column (`"t"."villaId"`).
export function villaIdScopeSql(column: string): Prisma.Sql {
  const scope = currentVillaScope();
  if (!scope) return Prisma.sql`TRUE`;
  return Prisma.sql`${Prisma.raw(column)} IN (SELECT "id" FROM "Villa" WHERE "electricalEngineerId" = ${scope.engineerId})`;
}

// The same as a list to push onto a query's conditions: empty when the request is not limited.
export function villaIdScopeConditions(column: string): Prisma.Sql[] {
  return currentVillaScope() ? [villaIdScopeSql(column)] : [];
}

// For raw SQL on daily reports: a condition on the engineer who prepared it (`"r"."preparedByEngineerId"`).
export function ownEngineerSql(column: string): Prisma.Sql {
  const scope = currentVillaScope();
  if (!scope) return Prisma.sql`TRUE`;
  return Prisma.sql`${Prisma.raw(column)} = ${scope.engineerId}`;
}

// Pieces to put straight into raw SQL: nothing at all when the request is not limited (the query is then exactly what
// it was), else " AND <condition>" or " WHERE <condition>". Written right after the text they extend, without a space.
export function andVillaScope(alias = "v"): Prisma.Sql {
  return currentVillaScope() ? Prisma.sql` AND ${villaScopeSql(alias)}` : Prisma.empty;
}

export function whereVillaScope(alias = "v"): Prisma.Sql {
  return currentVillaScope() ? Prisma.sql` WHERE ${villaScopeSql(alias)}` : Prisma.empty;
}

export function andVillaIdScope(column: string): Prisma.Sql {
  return currentVillaScope() ? Prisma.sql` AND ${villaIdScopeSql(column)}` : Prisma.empty;
}

export function whereVillaIdScope(column: string): Prisma.Sql {
  return currentVillaScope() ? Prisma.sql` WHERE ${villaIdScopeSql(column)}` : Prisma.empty;
}

export function andOwnEngineer(column: string): Prisma.Sql {
  return currentVillaScope() ? Prisma.sql` AND ${ownEngineerSql(column)}` : Prisma.empty;
}

// What a model's rows must match to be in the scope; undefined: the model is not limited.
export function scopeWhere(model: string, engineerId: string): Record<string, unknown> | undefined {
  const villa = { electricalEngineerId: engineerId };
  switch (model) {
    case "Villa":
      return villa;
    case "VillaMaterialRequirement":
    case "VillaMaterialOrder":
    case "MaterialDelivery":
    case "OwnerNote":
    case "ForemanMission":
    case "ContractorPayment":
    case "VariationOrder":
    case "OverheadExpense":
    case "VillaFinance":
    case "VillaPhaseProgress":
    case "WorkItem":
    case "DailySmallWork":
    case "SiteReport":
    case "DailyLabour":
    case "VillaDocument":
    case "VillaImage":
    case "ProgressPayment":
    case "MewInspectionReport":
      return { villa };
    case "MaterialDeliveryLine":
    case "MaterialDeliveryNote":
      return { delivery: { villa } };
    case "ContractorPaymentFile":
      return { payment: { villa } };
    case "OverheadExpenseFile":
      return { expense: { villa } };
    // A daily report is the engineer's own: the one who prepared it.
    case "DailyReport":
      return { preparedByEngineerId: engineerId };
    default:
      return undefined;
  }
}

const FILTERED = new Set([
  "findMany",
  "findFirst",
  "findFirstOrThrow",
  "findUnique",
  "findUniqueOrThrow",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

// Adds the scope to a where, keeping its own keys at the top (a unique where must keep its unique fields there).
export function withScope(where: unknown, scope: Record<string, unknown>): Record<string, unknown> {
  const base = (where ?? {}) as Record<string, unknown>;
  const and = base["AND"];
  const existing = and === undefined ? [] : Array.isArray(and) ? and : [and];
  return { ...base, AND: [...existing, scope] };
}

// The villa a create names, by id or by connect; undefined when it names none.
function villaIdOf(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  if (typeof record["villaId"] === "string") return record["villaId"];
  const villa = record["villa"] as { connect?: { id?: unknown } } | undefined;
  return typeof villa?.connect?.id === "string" ? villa.connect.id : undefined;
}

// A villa outside the scope, as Prisma reports a record it cannot find: the services already answer it with their own
// "not found".
function outOfScope(model: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`No ${model} found in the request's villa scope`, {
    code: "P2025",
    clientVersion: Prisma.prismaVersion.client,
    meta: { modelName: model, cause: "outside the villa scope" },
  });
}

type QueryArgs = {
  model?: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: unknown) => Promise<unknown>;
};

/**
 * The client with the villa scope on every model query: reads, counts, updates and deletes only reach the rows in the
 * scope, and a create for a villa outside it is refused. Raw SQL is not seen here: the repositories add the raw SQL
 * helpers above themselves.
 */
export function withVillaScope<C extends { $extends: (extension: never) => unknown }>(client: C): C {
  const base = client as unknown as {
    villa: { count: (args: unknown) => Promise<number> };
    $extends: (extension: unknown) => unknown;
  };
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }: QueryArgs) {
          const scope = currentVillaScope();
          if (!scope || !model) return query(args);
          const where = scopeWhere(model, scope.engineerId);
          if (!where) return query(args);
          if (FILTERED.has(operation)) {
            return query({ ...args, where: withScope(args["where"], where) });
          }
          if (operation === "create" || operation === "createMany" || operation === "createManyAndReturn") {
            const rows = Array.isArray(args["data"]) ? args["data"] : [args["data"]];
            // A villa made inside the scope is one of the engineer's own.
            if (model === "Villa") {
              for (const row of rows as Record<string, unknown>[]) {
                if (row?.["electricalEngineerId"] !== scope.engineerId) throw outOfScope("Villa");
              }
              return query(args);
            }
            const villaIds = new Set(rows.map(villaIdOf).filter((id): id is string => id !== undefined));
            for (const villaId of villaIds) {
              const inScope = await base.villa.count({
                where: { id: villaId, electricalEngineerId: scope.engineerId },
              });
              if (inScope === 0) throw outOfScope("Villa");
            }
          }
          return query(args);
        },
      },
    },
  }) as C;
}
