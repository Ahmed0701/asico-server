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
  // The user account linked to the engineer: signed in, it sees only this engineer's villas. Null: none.
  user: { id: string; name: string; email: string } | null;
  // How many villas have this engineer.
  villaCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ElectricalEngineerOptionDto = { id: string; name: string };

export type ElectricalEngineerListResult = { items: ElectricalEngineerDto[]; meta: PageMeta };

// A user the engineer form can link: every user that is not an ADMIN, with the engineer it is linked to now, if any.
export type ElectricalEngineerUserOptionDto = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  engineer: { id: string; name: string } | null;
};
