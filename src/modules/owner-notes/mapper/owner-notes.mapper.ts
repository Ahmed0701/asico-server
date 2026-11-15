import { locationOf } from "../../villas/mapper/villas.mapper.js";
import type { OwnerNoteDto } from "../dto/owner-notes.dto.js";
import type { OwnerNoteRow } from "../repository/owner-notes.repository.js";

export function toOwnerNoteDto(row: OwnerNoteRow): OwnerNoteDto {
  return {
    id: row.id,
    villa: {
      id: row.villa.id,
      villaNumber: row.villa.villaNumber,
      location: locationOf(row.villa.area.name, row.villa.block, row.villa.plot),
    },
    ownerName: row.villa.ownerName,
    notes: row.notes,
    done: row.doneAt !== null,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit entry records.
export function toOwnerNoteSnapshot(row: OwnerNoteRow) {
  return {
    villaId: row.villa.id,
    villaNumber: row.villa.villaNumber,
    notes: row.notes,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
  };
}
