import type { ElecPhaseDto, ElecPhaseOptionDto } from "../dto/elec-phases.dto.js";
import type { ElecPhaseRow } from "../repository/elec-phases.repository.js";

export function toElecPhaseDto(row: ElecPhaseRow): ElecPhaseDto {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sortOrder,
    status: row.status,
    progressRatio: row.progressRatio,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toOptionDto(row: { id: string; name: string }): ElecPhaseOptionDto {
  return { id: row.id, name: row.name };
}
