import { prisma } from "../src/core/database/prisma.js";
import { IdempotencyRepository } from "../src/core/idempotency/index.js";

// Deletes the Idempotency-Key rows that are past their 24 hours. Safe to run at any time and as often as you like
// (a row that is still good is never touched); run it daily from a scheduler of your choice. See docs/write-safety.md.
const removed = await new IdempotencyRepository().purgeExpired();
console.log(`removed ${removed} expired idempotency key${removed === 1 ? "" : "s"}`);
await prisma.$disconnect();
