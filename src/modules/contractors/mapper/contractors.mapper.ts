import { toDay } from "../../../shared/utils/day.js";
import type {
  ContractorDto,
  ContractorOptionDto,
  ContractorVillaDto,
  ContractorSummaryDto,
} from "../dto/contractors.dto.js";
import type {
  ContractorFigures,
  ContractorRow,
  ContractorVillaRow,
} from "../repository/contractors.repository.js";

const toNumber = (value: bigint | number): number => Number(value);
const dayOrNull = (date: Date | null): string | null => (date === null ? null : toDay(date));

export function toContractorDto(row: ContractorRow): ContractorDto {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    status: row.status,
    villaCount: row._count.villas,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toOptionDto(row: { id: string; name: string }): ContractorOptionDto {
  return { id: row.id, name: row.name };
}

export function toVillaDto(villa: ContractorVillaRow): ContractorVillaDto {
  return {
    id: villa.id,
    villaNumber: villa.villaNumber,
    area: villa.area.name,
    block: villa.block,
    plot: villa.plot,
    startDate: villa.startDate ? toDay(villa.startDate) : null,
    targetDate: villa.targetDate ? toDay(villa.targetDate) : null,
  };
}

// `figures` holds only the sections the viewer may read; the others are null.
export function toSummaryDto(
  contractor: Pick<ContractorRow, "id" | "name" | "phone">,
  villaCount: number,
  villas: ContractorVillaRow[],
  figures: Partial<ContractorFigures> = {},
): ContractorSummaryDto {
  const { openWorks, smallWorks, dailyReports, labour } = figures;
  return {
    contractor: { id: contractor.id, name: contractor.name, phone: contractor.phone },
    villaCount,
    openWorks: openWorks
      ? {
          total: toNumber(openWorks.total),
          byStatus: {
            NOT_STARTED: toNumber(openWorks.notStarted),
            IN_PROGRESS: toNumber(openWorks.inProgress),
            DELAYED: toNumber(openWorks.delayed),
            DONE: toNumber(openWorks.done),
          },
          delayed: toNumber(openWorks.delayed),
          overdue: toNumber(openWorks.overdue),
        }
      : null,
    smallWorks: smallWorks
      ? {
          total: toNumber(smallWorks.total),
          pending: toNumber(smallWorks.pending),
          done: toNumber(smallWorks.done),
          overdue: toNumber(smallWorks.overdue),
          dueSoon: toNumber(smallWorks.dueSoon),
        }
      : null,
    dailyReports: dailyReports
      ? { count: toNumber(dailyReports.count), lastReportDate: dayOrNull(dailyReports.lastReportDate) }
      : null,
    labour: labour
      ? {
          entries: toNumber(labour.entries),
          totalLabour: toNumber(labour.totalLabour),
          lastLabourDate: dayOrNull(labour.lastLabourDate),
        }
      : null,
    villas: villas.map(toVillaDto),
  };
}
