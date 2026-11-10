import { FACTORY_TYPES } from "../../../shared/constants/enums.js";
import { toDay } from "../../../shared/utils/day.js";
import type {
  BalanceRowDto,
  BalanceStatus,
  FactoryDto,
  MaterialDeliveryDto,
  MaterialItemDto,
  MaterialsSummaryDto,
  MaterialTotalDto,
} from "../dto/materials.dto.js";
import type { BalanceRow } from "../repository/balance.repository.js";
import type { DeliveryCountRow, DeliveryRow } from "../repository/deliveries.repository.js";
import type { FactoryRow } from "../repository/factories.repository.js";
import type { ItemRow } from "../repository/items.repository.js";

// Two decimals, the precision the quantities are stored with (a sum of floats can carry noise).
const round2 = (value: number): number => Math.round(value * 100) / 100;

export function toFactoryDto(row: FactoryRow): FactoryDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    deliveryCount: row._count.deliveries,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const toFactorySnapshot = (row: Pick<FactoryRow, "name" | "type">) => ({
  name: row.name,
  type: row.type,
});

export function toItemDto(row: ItemRow): MaterialItemDto {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    unit: row.unit,
    sortOrder: row.sortOrder,
    requiredPerVilla: row.requiredPerVilla,
    lineCount: row._count.lines,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const toItemSnapshot = (row: ItemRow) => ({
  name: row.name,
  type: row.type,
  unit: row.unit,
  sortOrder: row.sortOrder,
  requiredPerVilla: row.requiredPerVilla,
});

export function toDeliveryDto(row: DeliveryRow): MaterialDeliveryDto {
  return {
    id: row.id,
    villa: { id: row.villa.id, villaNumber: row.villa.villaNumber },
    factory: { id: row.factory.id, name: row.factory.name, type: row.factory.type },
    lines: row.lines.map((line) => ({
      item: { id: line.item.id, name: line.item.name, unit: line.item.unit },
      quantity: line.quantity,
    })),
    noteNumber: row.noteNumber,
    deliveryDate: toDay(row.deliveryDate),
    deliveryNotes: row.notes.map((note) => ({
      id: note.id,
      name: note.name,
      mimeType: note.mime,
      sizeBytes: note.size,
      uploadedAt: note.uploadedAt.toISOString(),
    })),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit entry records about a delivery (the file's storage key included, so a removed file can be found).
export function toDeliverySnapshot(row: DeliveryRow) {
  return {
    villaId: row.villaId,
    villaNumber: row.villa.villaNumber,
    factoryId: row.factoryId,
    lines: row.lines.map((line) => ({ item: line.item.name, quantity: line.quantity, unit: line.item.unit })),
    noteNumber: row.noteNumber,
    deliveryDate: toDay(row.deliveryDate),
    notes: row.notes.map((note) => ({ name: note.name, key: note.key })),
  };
}

export function balanceStatus(required: number, delivered: number): BalanceStatus {
  if (delivered < required) return "PENDING";
  return delivered === required ? "COMPLETE" : "OVER";
}

export function toBalanceRowDto(row: BalanceRow): BalanceRowDto {
  return {
    villa: { id: row.villaId, villaNumber: row.villaNumber },
    item: { id: row.itemId, name: row.name, unit: row.unit, type: row.type },
    required: row.required,
    custom: row.custom,
    delivered: row.delivered,
    balance: round2(row.required - row.delivered),
    status: balanceStatus(row.required, row.delivered),
  };
}

export function toSummaryDto(
  villaId: string,
  counts: DeliveryCountRow[],
  rows: BalanceRow[],
): MaterialsSummaryDto {
  const materials: MaterialTotalDto[] = rows.map((row) => ({
    type: row.type,
    itemId: row.itemId,
    name: row.name,
    unit: row.unit,
    required: row.required,
    custom: row.custom,
    delivered: row.delivered,
    balance: round2(row.required - row.delivered),
    status: balanceStatus(row.required, row.delivered),
    deliveries: row.deliveries,
    withNote: row.withNote,
  }));
  const deliveries = counts.reduce((sum, row) => sum + row.deliveries, 0);
  const withNote = counts.reduce((sum, row) => sum + row.withNote, 0);
  const byType = FACTORY_TYPES.map((type) => ({
    type,
    deliveries: counts.find((row) => row.type === type)?.deliveries ?? 0,
  }));
  return { villaId, deliveries, withNote, withoutNote: deliveries - withNote, byType, materials };
}
