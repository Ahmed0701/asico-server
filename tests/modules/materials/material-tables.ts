import type { FactoryTypeValue } from "../../../src/shared/constants/enums.js";

// The factories, catalog, deliveries and villa requirements of the fakes. Imports nothing, so the shared fake transaction can
// count from it.

export type StoredFactory = {
  id: string;
  name: string;
  type: FactoryTypeValue;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredItem = {
  id: string;
  name: string;
  type: FactoryTypeValue;
  unit: string;
  sortOrder: number;
  requiredPerVilla: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredLine = { itemId: string; quantity: number };

export type StoredNote = {
  id: string;
  key: string;
  name: string;
  mime: string;
  size: number;
  uploadedAt: Date;
};

export type StoredDelivery = {
  id: string;
  villaId: string;
  factoryId: string;
  lines: StoredLine[];
  noteNumber: string | null;
  deliveryDate: Date;
  notes: StoredNote[];
  version: number;
  createdAt: Date;
  updatedAt: Date;
};

export type StoredRequirement = { villaId: string; itemId: string; quantity: number };

export const materialTables = {
  factories: [] as StoredFactory[],
  items: [] as StoredItem[],
  deliveries: [] as StoredDelivery[],
  requirements: [] as StoredRequirement[],
  reset(): void {
    this.factories = [];
    this.items = [];
    this.deliveries = [];
    this.requirements = [];
  },
  count(where: { villaId?: string; factoryId?: string }): number {
    return this.deliveries.filter(
      (d) =>
        (where.villaId === undefined || d.villaId === where.villaId) &&
        (where.factoryId === undefined || d.factoryId === where.factoryId),
    ).length;
  },
};
