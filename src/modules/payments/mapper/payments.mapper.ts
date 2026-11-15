import { toDay } from "../../../shared/utils/day.js";
import { locationOf } from "../../villas/mapper/villas.mapper.js";
import type { PaymentDto, PaymentFileDto } from "../dto/payments.dto.js";
import type { PaymentFileRow, PaymentRow } from "../repository/payments.repository.js";

export function toPaymentFileDto(file: PaymentFileRow): PaymentFileDto {
  return {
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    uploadedAt: file.uploadedAt.toISOString(),
  };
}

// `today` is the day of APP_TIMEZONE, YYYY-MM-DD: a pending payment due before it is overdue.
export function toPaymentDto(row: PaymentRow, today: string): PaymentDto {
  const dueDate = row.dueDate ? toDay(row.dueDate) : null;
  return {
    id: row.id,
    contractor: { id: row.contractor.id, name: row.contractor.name },
    villa: row.villa && {
      id: row.villa.id,
      villaNumber: row.villa.villaNumber,
      location: locationOf(row.villa.area.name, row.villa.block, row.villa.plot),
    },
    amountMinor: Number(row.amountMinor),
    status: row.status,
    dueDate,
    paidDate: row.paidDate ? toDay(row.paidDate) : null,
    method: row.method,
    reference: row.reference,
    notes: row.notes,
    overdue: row.status === "PENDING" && dueDate !== null && dueDate < today,
    files: row.files.map(toPaymentFileDto),
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// What the audit entry records.
export function toPaymentSnapshot(row: PaymentRow) {
  return {
    contractorId: row.contractor.id,
    contractorName: row.contractor.name,
    villaNumber: row.villa?.villaNumber ?? null,
    amountMinor: Number(row.amountMinor),
    status: row.status,
    dueDate: row.dueDate ? toDay(row.dueDate) : null,
    paidDate: row.paidDate ? toDay(row.paidDate) : null,
    method: row.method,
    reference: row.reference,
    notes: row.notes,
  };
}
