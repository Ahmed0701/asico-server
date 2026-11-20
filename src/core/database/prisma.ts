import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../generated/prisma/client.js";
import { env } from "../config/env.js";
import { TRANSACTION_DEFAULTS } from "./transactions.js";

// A schema named in DATABASE_URL (?schema=) other than public is used for every connection; public, or none, changes nothing.
const url = new URL(env.DATABASE_URL);
const schema = url.searchParams.get("schema");
const scratch =
  schema !== null && schema !== "public" && /^[a-z_][a-z0-9_]*$/.test(schema) ? schema : undefined;
if (scratch) url.searchParams.delete("schema");

const adapter = new PrismaPg(
  {
    connectionString: scratch ? url.toString() : env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    ...(scratch && { options: `-c search_path=${scratch}` }),
  },
  ...(scratch ? [{ schema: scratch }] : []),
);

export const prisma = new PrismaClient({ adapter, transactionOptions: TRANSACTION_DEFAULTS });
