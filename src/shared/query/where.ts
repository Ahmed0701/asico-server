export function cleanWhere<T extends Record<string, unknown>>(input: T): Partial<T> {
  const entries = Object.entries(input).filter(([, value]) => value !== undefined && value !== "");
  return Object.fromEntries(entries) as Partial<T>;
}

// Prisma's `contains` passes `%` and `_` through to LIKE as wildcards. Escape them (and the escape
// character itself, a backslash) so a search term always matches literally.
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}
