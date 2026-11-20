import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import type { PageMeta } from "../../../shared/query/pagination.js";

// How much of a villa's materials of one factory type came: all of what it needs, part of it, nothing yet, or it needs
// none of that type.
export const MATERIAL_ORDER_STATUSES = ["DELIVERED", "PARTIAL", "NOT_DELIVERED", "NOT_REQUIRED"] as const;
export type MaterialOrderStatus = (typeof MATERIAL_ORDER_STATUSES)[number];

export const MATERIAL_ORDER_SORT_FIELDS = ["villaNumber", "dueDate"] as const;
export type MaterialOrderSortField = (typeof MATERIAL_ORDER_SORT_FIELDS)[number];

// One villa's materials of one factory type (switchgear or cables): the dates of its material request (MR), purchase
// order (PO) and when it is due, and how much of it came.
export type MaterialOrderDto = {
  villa: { id: string; villaNumber: string };
  type: FactoryTypeValue;
  // The factory assigned to the villa for this type (Vendors); null when none.
  factory: { id: string; name: string } | null;
  // YYYY-MM-DD, as entered; null when not entered.
  mrDate: string | null;
  poDate: string | null;
  dueDate: string | null;
  // The earliest MR and PO dates on the villa's delivery notes of this type: what to show when none is entered.
  deliveryMrDate: string | null;
  deliveryPoDate: string | null;
  // The day of the villa's latest delivery of this type.
  lastDeliveryDate: string | null;
  // The materials of this type the villa needs, and how many of them came in full.
  requiredItems: number;
  completeItems: number;
  status: MaterialOrderStatus;
  // The due date has passed and not everything came.
  overdue: boolean;
};

export type MaterialOrdersSummaryDto = {
  total: number;
  delivered: number;
  partial: number;
  notDelivered: number;
  overdue: number;
};

export type MaterialOrdersResult = {
  items: MaterialOrderDto[];
  meta: PageMeta;
  summary: MaterialOrdersSummaryDto;
};
