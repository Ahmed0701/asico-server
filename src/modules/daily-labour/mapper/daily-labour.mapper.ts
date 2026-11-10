import { toDay } from "../../../shared/utils/day.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import type { DailyLabourDto, DailyLabourSnapshot } from "../dto/daily-labour.dto.js";
import type { DailyLabourRow } from "../repository/daily-labour.repository.js";

export function toDailyLabourDto(row: DailyLabourRow): DailyLabourDto {
  return {
    id: row.id,
    villa: {
      id: row.villa.id,
      villaNumber: row.villa.villaNumber,
      location: locationOf(row.villa.area.name, row.villa.block, row.villa.plot),
    },
    labourDate: toDay(row.labourDate),
    contractor: { id: row.contractor.id, name: row.contractor.name },
    labourCount: row.labourCount,
    notes: row.notes,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What an audit entry records about a labour row: its own fields, never what is derived from other tables.
export function toSnapshot(
  row: Pick<DailyLabourRow, "labourDate" | "contractorId" | "labourCount" | "notes"> & {
    villa: { id: string };
  },
): DailyLabourSnapshot {
  return {
    villaId: row.villa.id,
    labourDate: toDay(row.labourDate),
    contractorId: row.contractorId,
    labourCount: row.labourCount,
    notes: row.notes,
  };
}
