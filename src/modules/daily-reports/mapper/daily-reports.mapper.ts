import { toDay } from "../../../shared/utils/day.js";
import type { DailyReportDto, DailyReportSnapshot } from "../dto/daily-reports.dto.js";
import type { DailyReportRow } from "../repository/daily-reports.repository.js";

export function toDailyReportDto(row: DailyReportRow): DailyReportDto {
  return {
    id: row.id,
    reportDate: toDay(row.reportDate),
    weather: row.weather,
    workersCount: row.workersCount,
    notes: row.notes,
    contractor: { id: row.contractor.id, name: row.contractor.name },
    preparedBy: { id: row.preparedByEngineer.id, name: row.preparedByEngineer.name },
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What an audit entry records about a report: its own fields, never what is derived from other tables.
export function toSnapshot(
  row: Pick<
    DailyReportRow,
    "reportDate" | "weather" | "workersCount" | "notes" | "contractorId" | "preparedByEngineerId"
  >,
): DailyReportSnapshot {
  return {
    reportDate: toDay(row.reportDate),
    weather: row.weather,
    workersCount: row.workersCount,
    notes: row.notes,
    contractorId: row.contractorId,
    preparedByEngineerId: row.preparedByEngineerId,
  };
}
