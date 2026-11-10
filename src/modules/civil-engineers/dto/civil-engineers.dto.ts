import type { PageMeta } from "../../../shared/query/pagination.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";

export const CIVIL_ENGINEER_SORT_FIELDS = ["name", "createdAt"] as const;
export type CivilEngineerSortField = (typeof CIVIL_ENGINEER_SORT_FIELDS)[number];

export function isCivilEngineerSortField(value: string): value is CivilEngineerSortField {
  return (CIVIL_ENGINEER_SORT_FIELDS as readonly string[]).includes(value);
}

export type CivilEngineerSort = { field: CivilEngineerSortField; direction: "asc" | "desc" };

// The options list feeds select inputs. It is cut at this many entries so the response stays bounded.
export const MAX_OPTIONS = 1000;

export type CivilEngineerDto = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: PartyStatusValue;
  villaCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type CivilEngineerOptionDto = { id: string; name: string };

export type CivilEngineerListResult = { items: CivilEngineerDto[]; meta: PageMeta };
