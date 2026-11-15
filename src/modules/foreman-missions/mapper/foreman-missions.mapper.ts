import { locationOf } from "../../villas/mapper/villas.mapper.js";
import type { ForemanMissionDto } from "../dto/foreman-missions.dto.js";
import type { ForemanMissionRow } from "../repository/foreman-missions.repository.js";

export function toForemanMissionDto(row: ForemanMissionRow): ForemanMissionDto {
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
export function toForemanMissionSnapshot(row: ForemanMissionRow) {
  return {
    villaId: row.villa.id,
    villaNumber: row.villa.villaNumber,
    notes: row.notes,
    doneAt: row.doneAt ? row.doneAt.toISOString() : null,
  };
}
