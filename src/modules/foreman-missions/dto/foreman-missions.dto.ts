import type { PageMeta } from "../../../shared/query/pagination.js";

export const FOREMAN_MISSION_SORT_FIELDS = ["createdAt", "villaNumber", "doneAt"] as const;
export type ForemanMissionSortField = (typeof FOREMAN_MISSION_SORT_FIELDS)[number];

export function isForemanMissionSortField(value: string): value is ForemanMissionSortField {
  return (FOREMAN_MISSION_SORT_FIELDS as readonly string[]).includes(value);
}

export type ForemanMissionSort = { field: ForemanMissionSortField; direction: "asc" | "desc" };

// A foreman's mission at a villa. The villa number, location ("<area> . <block> . <plot>") and owner name come from the
// villa, as it is now (null: the villa has no owner name). `done` is true once someone checked it as done (`doneAt` is when); an open note
// is reminded once a day through the notifications.
export type ForemanMissionDto = {
  id: string;
  villa: { id: string; villaNumber: string; location: string };
  ownerName: string | null;
  notes: string;
  done: boolean;
  doneAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ForemanMissionListResult = { items: ForemanMissionDto[]; meta: PageMeta };
