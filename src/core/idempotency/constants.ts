// How long a key holds its response, and how long a request may hold a key without finishing.
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
// A request that claimed a key and never finished (the process died) stops blocking it after this long.
export const IDEMPOTENCY_STALE_MS = 2 * 60 * 1000;
