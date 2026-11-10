import type { PageMeta } from "../../../shared/query/pagination.js";
import type { PartyStatusValue } from "../../../shared/constants/enums.js";

export const ELECTRICAL_ENGINEER_SORT_FIELDS = ["name", "createdAt"] as const;
export type ElectricalEngineerSortField = (typeof ELECTRICAL_ENGINEER_SORT_FIELDS)[number];

export function isElectricalEngineerSortField(value: string): value is ElectricalEngineerSortField {
  return (ELECTRICAL_ENGINEER_SORT_FIELDS as readonly string[]).includes(value);
}

export type ElectricalEngineerSort = { field: ElectricalEngineerSortField; direction: "asc" | "desc" };

// The options list feeds select inputs. It is cut at this many entries so the response stays bounded.
export const MAX_OPTIONS = 1000;

export type ElectricalEngineerDto = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  status: PartyStatusValue;
  // How many villas have this engineer.
  villaCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ElectricalEngineerOptionDto = { id: string; name: string };

export type ElectricalEngineerListResult = { items: ElectricalEngineerDto[]; meta: PageMeta };
