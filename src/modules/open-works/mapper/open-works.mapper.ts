import { toDay } from "../../../shared/utils/day.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import { openWorkName, type OpenWorkDto, type OpenWorkSnapshot } from "../dto/open-works.dto.js";
import type { OpenWorkRow } from "../repository/open-works.repository.js";

const day = (date: Date | null): string | null => (date ? toDay(date) : null);

const DAY_MS = 24 * 60 * 60 * 1000;

// Whole days from the end date to today, when the work is late (0 otherwise).
function daysLate(endDate: Date | null, status: string, today: Date): number {
  if (endDate === null || status === "DONE" || endDate >= today) {
    return 0;
  }
  return Math.round((today.getTime() - endDate.getTime()) / DAY_MS);
}

// `today` is the current day of APP_TIMEZONE at 00:00 UTC: an item is overdue when its end date is before it and it is not done.
export function toOpenWorkDto(row: OpenWorkRow, today: Date): OpenWorkDto {
  const overdueDays = daysLate(row.endDate, row.status, today);
  return {
    id: row.id,
    villa: {
      id: row.villa.id,
      villaNumber: row.villa.villaNumber,
      location: locationOf(row.villa.area.name, row.villa.block, row.villa.plot),
    },
    elecPhase: { id: row.elecPhase.id, name: row.elecPhase.name },
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    contractor: row.contractor ? { id: row.contractor.id, name: row.contractor.name } : null,
    startDate: day(row.startDate),
    endDate: day(row.endDate),
    overdue: overdueDays > 0,
    overdueDays,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What an audit entry records about an item: its own fields, never what is derived from other tables.
export function toSnapshot(
  row: Pick<
    OpenWorkRow,
    "elecPhaseId" | "status" | "priority" | "progress" | "contractorId" | "startDate" | "endDate"
  > & { villa: { id: string; villaNumber: string }; elecPhase: { name: string } },
): OpenWorkSnapshot {
  return {
    name: openWorkName(row.elecPhase.name, row.villa.villaNumber),
    villaId: row.villa.id,
    elecPhaseId: row.elecPhaseId,
    status: row.status,
    priority: row.priority,
    progress: row.progress,
    contractorId: row.contractorId,
    startDate: day(row.startDate),
    endDate: day(row.endDate),
  };
}
