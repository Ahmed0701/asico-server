export const VARIATION_ORDER_STATUSES = ["PENDING", "PAID"] as const;
export type VariationOrderStatusValue = (typeof VARIATION_ORDER_STATUSES)[number];

// PDF files of one variation order, at most.
export const MAX_VARIATION_ORDER_FILES = 10;

export type VariationOrderFileDto = {
  id: string;
  name: string;
  mime: string;
  size: number;
  uploadedAt: string;
};

// A variation order of a villa. `amountMinor` is KWD fils (1 KWD = 1000). `dateAdded` is YYYY-MM-DD.
export type VariationOrderDto = {
  id: string;
  villaId: string;
  voNumber: string;
  amountMinor: number;
  dateAdded: string;
  status: VariationOrderStatusValue;
  notes: string | null;
  files: VariationOrderFileDto[];
  version: number;
  createdAt: string;
  updatedAt: string;
};

// The amounts of all the variation orders of the villa: still pending, and paid.
export type VariationOrderTotalsDto = {
  pendingMinor: number;
  paidMinor: number;
};

export type VariationOrderListResult = { items: VariationOrderDto[]; totals: VariationOrderTotalsDto };
