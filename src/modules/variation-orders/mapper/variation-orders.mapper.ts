import { toDay } from "../../../shared/utils/day.js";
import type { VariationOrderDto, VariationOrderFileDto } from "../dto/variation-orders.dto.js";
import type { VariationOrderFileRow, VariationOrderRow } from "../repository/variation-orders.repository.js";

export function toVariationOrderFileDto(file: VariationOrderFileRow): VariationOrderFileDto {
  return {
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    uploadedAt: file.uploadedAt.toISOString(),
  };
}

export function toVariationOrderDto(row: VariationOrderRow): VariationOrderDto {
  return {
    id: row.id,
    villaId: row.villaId,
    voNumber: row.voNumber,
    amountMinor: Number(row.amountMinor),
    dateAdded: toDay(row.dateAdded),
    status: row.status,
    notes: row.notes,
    files: row.files.map(toVariationOrderFileDto),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit entry records.
export function toVariationOrderSnapshot(row: VariationOrderRow) {
  return {
    villaId: row.villaId,
    villaNumber: row.villa.villaNumber,
    voNumber: row.voNumber,
    amountMinor: Number(row.amountMinor),
    dateAdded: toDay(row.dateAdded),
    status: row.status,
    notes: row.notes,
  };
}
