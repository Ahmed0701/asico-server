import type { PageMeta } from "../../../shared/query/pagination.js";

export const AREA_SORT_FIELDS = ["name", "city", "villaCount", "createdAt"] as const;
export type AreaSortField = (typeof AREA_SORT_FIELDS)[number];

export function isAreaSortField(value: string): value is AreaSortField {
  return (AREA_SORT_FIELDS as readonly string[]).includes(value);
}

export type AreaSort = { field: AreaSortField; direction: "asc" | "desc" };

// The options list feeds select inputs. It is cut at this many entries so the response stays bounded.
export const MAX_OPTIONS = 1000;

// `villaCount` is counted when the area is read; it is not a column.
export type AreaDto = {
  id: string;
  name: string;
  city: string;
  villaCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type AreaOptionDto = { id: string; name: string; city: string };

export type AreaListResult = { items: AreaDto[]; meta: PageMeta };
