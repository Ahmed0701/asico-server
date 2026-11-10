import { toDay } from "../../../shared/utils/day.js";
import { averageProgress, stateOf, villaProgressOf } from "../../villa-progress/dto/villa-progress.dto.js";
import type {
  MarkSnapshot,
  VillaDetailDto,
  VillaListItemDto,
  VillaOptionDto,
  VillaSnapshot,
} from "../dto/villas.dto.js";
import type {
  InspectionMark,
  MarkRow,
  VillaMark,
  VillaDetailRow,
  VillaListRow,
  VillaSnapshotRow,
} from "../repository/villas.repository.js";

const day = (date: Date | null): string | null => (date ? toDay(date) : null);

// The budget is a BIGINT in the database and a JSON number in the API. The database refuses anything above
// 2^53 - 1, so the conversion is exact.
const budget = (value: bigint | null): number | null => (value === null ? null : Number(value));

// "<area> . <block> . <plot>"
export const locationOf = (area: string, block: string, plot: string): string =>
  `${area} . ${block} . ${plot}`;

export function toListItemDto(row: VillaListRow): VillaListItemDto {
  return {
    id: row.id,
    villaNumber: row.villaNumber,
    ownerName: row.ownerName,
    villaType: row.villaType,
    area: row.area.name,
    areaId: row.areaId,
    block: row.block,
    plot: row.plot,
    location: locationOf(row.area.name, row.block, row.plot),
    civilEngineer: { id: row.civilEngineer.id, name: row.civilEngineer.name },
    electricalEngineer: row.electricalEngineer
      ? { id: row.electricalEngineer.id, name: row.electricalEngineer.name }
      : null,
    contractor: row.contractor ? { id: row.contractor.id, name: row.contractor.name } : null,
    startDate: day(row.startDate),
    targetDate: day(row.targetDate),
    budgetMinor: budget(row.budgetMinor),
    currency: row.currency,
    progress: villaProgressOf(row.doneRatio),
    mewFollowUp: row.mewFollowUpAt
      ? {
          at: row.mewFollowUpAt.toISOString(),
          by: row.mewFollowUpBy ? { id: row.mewFollowUpBy.id, name: row.mewFollowUpBy.name } : null,
        }
      : null,
    mewInspection: row.mewInspectionAt
      ? {
          at: row.mewInspectionAt.toISOString(),
          by: row.mewInspectionBy ? { id: row.mewInspectionBy.id, name: row.mewInspectionBy.name } : null,
        }
      : null,
    mewInspectionPassed: row.mewInspectionPassedAt
      ? {
          at: row.mewInspectionPassedAt.toISOString(),
          by: row.mewInspectionPassedBy
            ? { id: row.mewInspectionPassedBy.id, name: row.mewInspectionPassedBy.name }
            : null,
        }
      : null,
    mewAcState: row.mewAcState,
    mewElecState: row.mewElecState,
    mewInspectionDate: day(row.mewInspectionDate),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toDetailDto(row: VillaDetailRow): VillaDetailDto {
  return {
    ...toListItemDto(row),
    civilEngineer: { id: row.civilEngineer.id, name: row.civilEngineer.name, phone: row.civilEngineer.phone },
    electricalEngineer: row.electricalEngineer
      ? {
          id: row.electricalEngineer.id,
          name: row.electricalEngineer.name,
          phone: row.electricalEngineer.phone,
        }
      : null,
    contractor: row.contractor
      ? { id: row.contractor.id, name: row.contractor.name, phone: row.contractor.phone }
      : null,
    createdBy: { id: row.createdBy.id, name: row.createdBy.name },
    phaseCount: row.phaseCount,
    phases: row.phases.map((phase) => ({
      elecPhaseId: phase.elecPhaseId,
      name: phase.name,
      order: phase.sortOrder,
      // From the villa's open works, to one decimal like the overall progress.
      progress: averageProgress(phase.progress, 1),
      state: stateOf(phase.progress),
      version: phase.version,
    })),
  };
}

// What audit entries record about a villa: plain values, dates as YYYY-MM-DD, the budget as a number.
export function toSnapshot(row: VillaSnapshotRow): VillaSnapshot {
  return {
    villaNumber: row.villaNumber,
    ownerName: row.ownerName,
    villaType: row.villaType,
    areaId: row.areaId,
    block: row.block,
    plot: row.plot,
    civilEngineerId: row.civilEngineerId,
    electricalEngineerId: row.electricalEngineerId,
    contractorId: row.contractorId,
    startDate: day(row.startDate),
    targetDate: day(row.targetDate),
    budgetMinor: budget(row.budgetMinor),
    currency: row.currency,
  };
}

// What the audit entry of a MEW follow-up or MEW inspection change records: the mark as stored, or the one it is about to
// become, under the mark's own names.
export function toMarkSnapshot(mark: VillaMark, value: MarkRow | InspectionMark): MarkSnapshot {
  const at = value === null ? null : value.at instanceof Date ? value.at.toISOString() : null;
  const byId = value === null ? null : value.byId;
  return { [`${mark}At`]: at, [`${mark}ById`]: byId };
}

export function toOptionDto(row: { id: string; villaNumber: string }): VillaOptionDto {
  return { id: row.id, villaNumber: row.villaNumber };
}
