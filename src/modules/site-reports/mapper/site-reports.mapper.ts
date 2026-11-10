import { toDay } from "../../../shared/utils/day.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import type { SiteReportDto, SiteReportSnapshot } from "../dto/site-reports.dto.js";
import type { SiteReportRow } from "../repository/site-reports.repository.js";

export function toSiteReportDto(row: SiteReportRow): SiteReportDto {
  return {
    id: row.id,
    villa: {
      id: row.villa.id,
      villaNumber: row.villa.villaNumber,
      location: locationOf(row.villa.area.name, row.villa.block, row.villa.plot),
    },
    visitDate: toDay(row.visitDate),
    title: row.title,
    inspector: row.inspector,
    type: row.type,
    rating: row.rating,
    findings: row.findings,
    recommendations: row.recommendations,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What an audit entry records about a site report: its own fields, never what is derived from other tables.
export function toSnapshot(
  row: Pick<
    SiteReportRow,
    "visitDate" | "title" | "inspector" | "type" | "rating" | "findings" | "recommendations"
  > & { villa: { id: string } },
): SiteReportSnapshot {
  return {
    villaId: row.villa.id,
    visitDate: toDay(row.visitDate),
    title: row.title,
    inspector: row.inspector,
    type: row.type,
    rating: row.rating,
    findings: row.findings,
    recommendations: row.recommendations,
  };
}
