import { z } from "zod";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 1000;
// Keeps `skip` (page * limit) well inside a 32-bit integer.
export const MAX_PAGE = 100_000;

// Out-of-range values are rejected, not clamped. Use with `validate(paginationQuerySchema, "query")`.
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

export type PaginationQuery = z.output<typeof paginationQuerySchema>;

export type Pagination = {
  page: number;
  limit: number;
  skip: number;
  take: number;
};

export type PageMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export function toPagination({ page, limit }: PaginationQuery): Pagination {
  return {
    page,
    limit,
    skip: (page - 1) * limit,
    take: limit,
  };
}

export function buildMeta(page: number, limit: number, total: number): PageMeta {
  return {
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
  };
}
