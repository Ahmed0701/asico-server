import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import type { PageMeta } from "../../../shared/query/pagination.js";

// A switchgear or cable factory. `deliveryCount` is counted when it is read: a factory with deliveries cannot be deleted.
export type FactoryDto = {
  id: string;
  name: string;
  type: FactoryTypeValue;
  deliveryCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

// A material of the catalog (MSB Box, DB Interior, a cable size...). A delivery's lines are picked from it, among the items of
// its factory's type. `lineCount` is how many delivery lines use it: an item in use cannot be deleted.
export type MaterialItemDto = {
  id: string;
  name: string;
  type: FactoryTypeValue;
  unit: string;
  sortOrder: number;
  // How much of it every villa needs (1 unless changed), unless a villa has its own quantity (0: not needed).
  requiredPerVilla: number;
  lineCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

// One delivery note file: a PDF, JPG or PNG. Opened with GET /material-deliveries/:id/notes/:noteId.
export type DeliveryNoteDto = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
};

// One material of a delivery. `quantity` has at most two decimals, in the item's unit.
export type DeliveryLineDto = {
  item: { id: string; name: string; unit: string };
  quantity: number;
};

// A delivery from a factory to a villa: its lines in catalog order, and its delivery note files (oldest first, empty until
// one is uploaded). `deliveryDate` is YYYY-MM-DD.
export type MaterialDeliveryDto = {
  id: string;
  villa: { id: string; villaNumber: string };
  factory: { id: string; name: string; type: FactoryTypeValue };
  lines: DeliveryLineDto[];
  noteNumber: string | null;
  deliveryDate: string;
  deliveryNotes: DeliveryNoteDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type MaterialDeliveryListResult = { items: MaterialDeliveryDto[]; meta: PageMeta };

// Where a material of a villa stands: still to come, all here, or more came than it needs.
export const BALANCE_STATUSES = ["PENDING", "COMPLETE", "OVER"] as const;
export type BalanceStatus = (typeof BALANCE_STATUSES)[number];

// One catalog item of a villa: what it needs (the catalog's quantity, or the villa's own when `custom`), what came, and the
// balance (required minus delivered; below 0 when more came than needed). `deliveries` and `withNote` count the deliveries
// that brought it and how many of them have their delivery note.
export type MaterialTotalDto = {
  type: FactoryTypeValue;
  itemId: string;
  name: string;
  unit: string;
  required: number;
  custom: boolean;
  delivered: number;
  balance: number;
  status: BalanceStatus;
  deliveries: number;
  withNote: number;
};

// A line of the balance list: one material of one villa that it needs or received.
export type BalanceRowDto = {
  villa: { id: string; villaNumber: string };
  item: { id: string; name: string; unit: string; type: FactoryTypeValue };
  required: number;
  custom: boolean;
  delivered: number;
  balance: number;
  status: BalanceStatus;
};

// The balance list, and the quantity still to come per material, added up over every row that matches (all pages).
export type BalanceListResult = {
  items: BalanceRowDto[];
  meta: PageMeta;
  totals: {
    item: { id: string; name: string; unit: string; type: FactoryTypeValue };
    balance: number;
    villas: number;
  }[];
};

// What a villa has received: how many deliveries, how many have their delivery note, by type, and per material.
export type MaterialsSummaryDto = {
  villaId: string;
  deliveries: number;
  withNote: number;
  withoutNote: number;
  byType: { type: FactoryTypeValue; deliveries: number }[];
  materials: MaterialTotalDto[];
};

export const DELIVERY_SORT_FIELDS = ["deliveryDate", "createdAt"] as const;
export type DeliverySortField = (typeof DELIVERY_SORT_FIELDS)[number];
export type DeliverySort = { field: DeliverySortField; direction: "asc" | "desc" };

export function isDeliverySortField(value: string): value is DeliverySortField {
  return (DELIVERY_SORT_FIELDS as readonly string[]).includes(value);
}

// At most this many lines on one delivery (the catalog of a type is about a dozen items).
export const MAX_LINES = 50;

// The files a delivery note may be, told apart by their first bytes (never by the name or what the client says).
export const NOTE_TYPES = [
  { mime: "application/pdf", extension: "pdf", signature: Buffer.from("%PDF-") },
  { mime: "image/jpeg", extension: "jpg", signature: Buffer.from([0xff, 0xd8, 0xff]) },
  {
    mime: "image/png",
    extension: "png",
    signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
] as const;
export const NOTE_HEAD_BYTES = 8;

// At most this many delivery note files on one delivery (the pages of a note, photographed one by one).
export const MAX_NOTES = 10;
