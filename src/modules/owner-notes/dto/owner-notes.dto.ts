import type { PageMeta } from "../../../shared/query/pagination.js";

export const OWNER_NOTE_SORT_FIELDS = ["createdAt", "villaNumber", "doneAt"] as const;
export type OwnerNoteSortField = (typeof OWNER_NOTE_SORT_FIELDS)[number];

export function isOwnerNoteSortField(value: string): value is OwnerNoteSortField {
  return (OWNER_NOTE_SORT_FIELDS as readonly string[]).includes(value);
}

export type OwnerNoteSort = { field: OwnerNoteSortField; direction: "asc" | "desc" };

// An owner's note about a villa. The villa number, location ("<area> . <block> . <plot>") and owner name come from the
// villa, as it is now (null: the villa has no owner name). `done` is true once someone checked it as done (`doneAt` is when); an open note
// is reminded once a day through the notifications.
export type OwnerNoteDto = {
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

export type OwnerNoteListResult = { items: OwnerNoteDto[]; meta: PageMeta };
