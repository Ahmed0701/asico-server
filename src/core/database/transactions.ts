// How long a transaction may wait for a free connection (`maxWait`) and run (`timeout`), unless a call sets its own (the
// imports and the nightly jobs do). Prisma's own defaults (2 s and 5 s) are too tight for a burst of traffic: a request
// that waits a little longer for a connection is better than one that fails. Found by the heavy load check.
export const TRANSACTION_DEFAULTS = { maxWait: 10_000, timeout: 20_000 } as const;

// The database was too busy to answer in time: no free connection, or a transaction that could not start or ran past its
// time. The caller is told to try again (503), not that something broke (500).
export function isDatabaseBusy(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "P2028" || code === "P2024") return true;
  return typeof message === "string" && message.includes("timeout exceeded when trying to connect");
}
