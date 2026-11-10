import { deadlineState, type AlertWindow, type DeadlinePolicy } from "../../../shared/utils/deadline.js";
import { toDay } from "../../../shared/utils/day.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import type { SmallWorkDto, SmallWorkSnapshot } from "../dto/small-works.dto.js";
import type { SmallWorkRow } from "../repository/small-works.repository.js";

// What the flags of a work are counted against: the clock's reading and the zone's rules, fixed once per response.
export type DeadlineContext = { window: AlertWindow; policy: DeadlinePolicy };

export function toSmallWorkDto(row: SmallWorkRow, deadline: DeadlineContext): SmallWorkDto {
  const endDate = toDay(row.endDate);
  const state = deadlineState(endDate, row.status === "PENDING", deadline.window, deadline.policy);
  return {
    id: row.id,
    villa: {
      id: row.villa.id,
      villaNumber: row.villa.villaNumber,
      location: locationOf(row.villa.area.name, row.villa.block, row.villa.plot),
    },
    contractor: { id: row.contractor.id, name: row.contractor.name },
    startDate: toDay(row.startDate),
    endDate,
    deadlineAt: state.deadlineAt.toISOString(),
    overdue: state.overdue,
    dueSoon: state.dueSoon,
    description: row.description,
    status: row.status,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What an audit entry records about a small work: its own fields, never what is derived from other tables or from the clock.
export function toSnapshot(
  row: Pick<SmallWorkRow, "contractorId" | "startDate" | "endDate" | "description" | "status"> & {
    villa: { id: string };
  },
): SmallWorkSnapshot {
  return {
    villaId: row.villa.id,
    contractorId: row.contractorId,
    startDate: toDay(row.startDate),
    endDate: toDay(row.endDate),
    description: row.description,
    status: row.status,
  };
}
