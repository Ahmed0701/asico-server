import { toDay } from "../../../shared/utils/day.js";
import type { MaintenanceDto } from "../dto/maintenance.dto.js";
import type { MaintenanceRow } from "../repository/maintenance.repository.js";

export function toMaintenanceDto(row: MaintenanceRow): MaintenanceDto {
  return {
    id: row.id,
    villaNumber: row.villaNumber,
    location: row.location,
    handoverDate: toDay(row.handoverDate),
    issue: row.issue,
    solved: row.solvedAt !== null,
    solvedAt: row.solvedAt ? row.solvedAt.toISOString() : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit entry records.
export function toMaintenanceSnapshot(row: MaintenanceRow) {
  return {
    villaNumber: row.villaNumber,
    location: row.location,
    handoverDate: toDay(row.handoverDate),
    issue: row.issue,
    solvedAt: row.solvedAt ? row.solvedAt.toISOString() : null,
  };
}
