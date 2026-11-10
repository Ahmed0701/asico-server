import { randomUUID } from "node:crypto";
import { FACTORY_TYPES, type FactoryTypeValue } from "../../../src/shared/constants/enums.js";
import type { DeliverySort } from "../../../src/modules/materials/dto/materials.dto.js";
import type {
  BalanceFilters,
  BalanceRepository,
  BalanceRow,
  BalanceTotalRow,
} from "../../../src/modules/materials/repository/balance.repository.js";
import type {
  DeliveriesRepository,
  DeliveryCountRow,
  DeliveryFields,
  DeliveryFilters,
  DeliveryRow,
  ImportCatalog,
  LineInput,
  NewDelivery,
  NewNote,
  NoteRow,
} from "../../../src/modules/materials/repository/deliveries.repository.js";
import type {
  Db,
  FactoriesRepository,
  FactoryRow,
} from "../../../src/modules/materials/repository/factories.repository.js";
import type {
  ItemFields,
  ItemRow,
  ItemsRepository,
} from "../../../src/modules/materials/repository/items.repository.js";
import { store, transactionLock } from "../auth/in-memory-auth.repository.js";
import { inMemoryTransaction } from "../users/in-memory-users.repository.js";
import { villaTables } from "../villas/in-memory-villas.repository.js";
import {
  materialTables,
  type StoredDelivery,
  type StoredFactory,
  type StoredItem,
} from "./material-tables.js";

// The materials repositories over arrays: the same filters, sorting, compare-and-set, totals and balance as the SQL.

// The order of the FactoryType enum in the database: SWITCHGEAR, then CABLE.
const typeOrder = (type: FactoryTypeValue): number => FACTORY_TYPES.indexOf(type);
const round2 = (value: number): number => Math.round(value * 100) / 100;

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

// Like the database: whatever the work changed is undone when it throws.
function transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
  return transactionLock.run(async () => {
    const before = structuredClone({
      f: materialTables.factories,
      i: materialTables.items,
      d: materialTables.deliveries,
      r: materialTables.requirements,
    });
    try {
      return await inMemoryTransaction(work);
    } catch (err) {
      materialTables.factories = before.f;
      materialTables.items = before.i;
      materialTables.deliveries = before.d;
      materialTables.requirements = before.r;
      throw err;
    }
  });
}

export function addFactory(overrides: Partial<StoredFactory> = {}): StoredFactory {
  const now = new Date();
  const factory: StoredFactory = {
    id: randomUUID(),
    name: `Factory ${materialTables.factories.length + 1}`,
    type: "SWITCHGEAR",
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  materialTables.factories.push(factory);
  return factory;
}

export function addItem(overrides: Partial<StoredItem> = {}): StoredItem {
  const now = new Date();
  const item: StoredItem = {
    id: randomUUID(),
    name: `Item ${materialTables.items.length + 1}`,
    type: "SWITCHGEAR",
    unit: "pcs",
    sortOrder: (materialTables.items.length + 1) * 10,
    requiredPerVilla: 0,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  materialTables.items.push(item);
  return item;
}

export function addDelivery(
  overrides: Partial<StoredDelivery> & { villaId: string; factoryId: string; lines: LineInput[] },
): StoredDelivery {
  const now = new Date();
  const delivery: StoredDelivery = {
    id: randomUUID(),
    noteNumber: null,
    deliveryDate: new Date("2026-10-01T00:00:00.000Z"),
    notes: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  materialTables.deliveries.push(delivery);
  return delivery;
}

const factoryRow = (f: StoredFactory): FactoryRow => ({
  ...f,
  _count: { deliveries: materialTables.count({ factoryId: f.id }) },
});

export class InMemoryFactoriesRepository implements FactoriesRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transaction(work);
  }

  async list(type: FactoryTypeValue | undefined): Promise<FactoryRow[]> {
    return materialTables.factories
      .filter((f) => !type || f.type === type)
      .sort(
        (a, b) =>
          typeOrder(a.type) - typeOrder(b.type) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      )
      .map(factoryRow);
  }

  async findById(id: string): Promise<FactoryRow | null> {
    const f = materialTables.factories.find((x) => x.id === id);
    return f ? factoryRow(f) : null;
  }

  async findByName(type: FactoryTypeValue, name: string): Promise<{ id: string } | null> {
    const f = materialTables.factories.find(
      (x) => x.type === type && x.name.toLowerCase() === name.toLowerCase(),
    );
    return f ? { id: f.id } : null;
  }

  async create(data: { name: string; type: FactoryTypeValue }): Promise<FactoryRow> {
    if (materialTables.factories.some((f) => f.type === data.type && f.name === data.name))
      throw uniqueViolation();
    return factoryRow(addFactory(data));
  }

  async lockVersion(id: string): Promise<number | null> {
    return materialTables.factories.find((f) => f.id === id)?.version ?? null;
  }

  async update(
    id: string,
    version: number,
    data: { name?: string; type?: FactoryTypeValue },
  ): Promise<FactoryRow | null> {
    const f = materialTables.factories.find((x) => x.id === id);
    if (!f || f.version !== version) return null;
    Object.assign(f, data, { version: f.version + 1, updatedAt: new Date() });
    return factoryRow(f);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const at = materialTables.factories.findIndex((f) => f.id === id && f.version === version);
    if (at < 0) return false;
    materialTables.factories.splice(at, 1);
    return true;
  }

  async countDeliveries(id: string): Promise<number> {
    return materialTables.count({ factoryId: id });
  }
}

const lineCount = (itemId: string): number =>
  materialTables.deliveries.reduce((sum, d) => sum + d.lines.filter((l) => l.itemId === itemId).length, 0);

const itemRow = (i: StoredItem): ItemRow => ({ ...i, _count: { lines: lineCount(i.id) } });
const byCatalogOrder = (a: StoredItem, b: StoredItem): number =>
  typeOrder(a.type) - typeOrder(b.type) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

export class InMemoryItemsRepository implements ItemsRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transaction(work);
  }

  async list(type: FactoryTypeValue | undefined): Promise<ItemRow[]> {
    return materialTables.items
      .filter((i) => !type || i.type === type)
      .sort(byCatalogOrder)
      .map(itemRow);
  }

  async findById(id: string): Promise<ItemRow | null> {
    const i = materialTables.items.find((x) => x.id === id);
    return i ? itemRow(i) : null;
  }

  async findByName(type: FactoryTypeValue, name: string): Promise<{ id: string } | null> {
    const i = materialTables.items.find(
      (x) => x.type === type && x.name.toLowerCase() === name.toLowerCase(),
    );
    return i ? { id: i.id } : null;
  }

  async create(data: {
    name: string;
    type: FactoryTypeValue;
    unit: string;
    sortOrder?: number | undefined;
    requiredPerVilla?: number | undefined;
  }): Promise<ItemRow> {
    if (materialTables.items.some((i) => i.type === data.type && i.name === data.name))
      throw uniqueViolation();
    const last = Math.max(
      0,
      ...materialTables.items.filter((i) => i.type === data.type).map((i) => i.sortOrder),
    );
    return itemRow(
      addItem({
        name: data.name,
        type: data.type,
        unit: data.unit,
        sortOrder: data.sortOrder ?? last + 10,
        requiredPerVilla: data.requiredPerVilla ?? 1,
      }),
    );
  }

  async lockVersion(id: string): Promise<number | null> {
    return materialTables.items.find((i) => i.id === id)?.version ?? null;
  }

  async update(id: string, version: number, data: ItemFields): Promise<ItemRow | null> {
    const i = materialTables.items.find((x) => x.id === id);
    if (!i || i.version !== version) return null;
    Object.assign(i, data, { version: i.version + 1, updatedAt: new Date() });
    return itemRow(i);
  }

  async delete(id: string, version: number): Promise<boolean> {
    const at = materialTables.items.findIndex((i) => i.id === id && i.version === version);
    if (at < 0) return false;
    materialTables.items.splice(at, 1);
    materialTables.requirements = materialTables.requirements.filter((r) => r.itemId !== id);
    return true;
  }

  async countLines(id: string): Promise<number> {
    return lineCount(id);
  }
}

function deliveryRow(d: StoredDelivery): DeliveryRow {
  const villa = villaTables.villas.find((v) => v.id === d.villaId);
  const factory = materialTables.factories.find((f) => f.id === d.factoryId);
  if (!villa || !factory) throw new Error("a delivery points at a missing villa or factory");
  const lines = d.lines
    .map((line) => {
      const item = materialTables.items.find((i) => i.id === line.itemId);
      if (!item) throw new Error("a line points at a missing item");
      return { line, item };
    })
    .sort((a, b) => a.item.sortOrder - b.item.sortOrder || a.item.name.localeCompare(b.item.name))
    .map(({ line, item }) => ({
      itemId: line.itemId,
      quantity: line.quantity,
      item: { id: item.id, name: item.name, unit: item.unit, type: item.type, sortOrder: item.sortOrder },
    }));
  return {
    ...d,
    lines,
    notes: [...d.notes].sort((a, b) => a.uploadedAt.getTime() - b.uploadedAt.getTime()),
    villa: { id: villa.id, villaNumber: villa.villaNumber },
    factory: { id: factory.id, name: factory.name, type: factory.type },
  };
}

export class InMemoryDeliveriesRepository implements DeliveriesRepository {
  transaction<T>(work: (tx: Db) => Promise<T>): Promise<T> {
    return transaction(work);
  }

  async userExists(id: string): Promise<boolean> {
    return store.users.some((user) => user.id === id);
  }

  async importVillas(): Promise<{ id: string; villaNumber: string }[]> {
    return villaTables.villas.map((villa) => ({ id: villa.id, villaNumber: villa.villaNumber }));
  }

  async importCatalog(): Promise<ImportCatalog> {
    return {
      factories: materialTables.factories.map((f) => ({ id: f.id, name: f.name, type: f.type })),
      items: materialTables.items.map((i) => ({ id: i.id, name: i.name, type: i.type })),
    };
  }

  async lockVillasShared(villaIds: readonly string[]): Promise<Set<string>> {
    return new Set(
      villaTables.villas.filter((villa) => villaIds.includes(villa.id)).map((villa) => villa.id),
    );
  }

  async list(
    params: DeliveryFilters & { sort: DeliverySort; skip: number; take: number },
  ): Promise<{ rows: DeliveryRow[]; total: number }> {
    const term = params.search?.toLowerCase();
    const sign = params.sort.direction === "asc" ? 1 : -1;
    const key = (r: DeliveryRow) =>
      (params.sort.field === "createdAt" ? r.createdAt : r.deliveryDate).getTime();
    const rows = materialTables.deliveries
      .map(deliveryRow)
      .filter(
        (r) =>
          (!params.villaId || r.villaId === params.villaId) &&
          (!params.factoryId || r.factoryId === params.factoryId) &&
          (!params.itemId || r.lines.some((l) => l.itemId === params.itemId)) &&
          (!params.type || r.factory.type === params.type) &&
          (!params.deliveryFrom || r.deliveryDate >= params.deliveryFrom) &&
          (!params.deliveryTo || r.deliveryDate <= params.deliveryTo) &&
          (params.hasNote === undefined || r.notes.length > 0 === params.hasNote) &&
          (!term ||
            [
              ...r.lines.map((l) => l.item.name),
              r.noteNumber ?? "",
              r.factory.name,
              r.villa.villaNumber,
            ].some((t) => t.toLowerCase().includes(term))),
      )
      .sort((a, b) => (key(a) - key(b)) * sign || (a.id < b.id ? -1 : 1));
    return { rows: rows.slice(params.skip, params.skip + params.take), total: rows.length };
  }

  async findById(id: string): Promise<DeliveryRow | null> {
    const d = materialTables.deliveries.find((x) => x.id === id);
    return d ? deliveryRow(d) : null;
  }

  async villaExists(id: string): Promise<boolean> {
    return villaTables.villas.some((v) => v.id === id);
  }

  async factoryType(id: string): Promise<FactoryTypeValue | null> {
    return materialTables.factories.find((f) => f.id === id)?.type ?? null;
  }

  async itemTypes(ids: string[]): Promise<Map<string, FactoryTypeValue>> {
    return new Map(materialTables.items.filter((i) => ids.includes(i.id)).map((i) => [i.id, i.type]));
  }

  async create(data: NewDelivery): Promise<DeliveryRow> {
    return deliveryRow(addDelivery({ ...data, lines: data.lines.map((l) => ({ ...l })) }));
  }

  async lockVersion(id: string): Promise<number | null> {
    return materialTables.deliveries.find((d) => d.id === id)?.version ?? null;
  }

  async update(
    id: string,
    version: number,
    data: DeliveryFields,
    lines: LineInput[] | undefined,
  ): Promise<DeliveryRow | null> {
    const d = materialTables.deliveries.find((x) => x.id === id);
    if (!d || d.version !== version) return null;
    Object.assign(d, data, { version: d.version + 1, updatedAt: new Date() });
    if (lines) d.lines = lines.map((l) => ({ ...l }));
    return deliveryRow(d);
  }

  async addNotes(deliveryId: string, notes: NewNote[]): Promise<void> {
    const d = materialTables.deliveries.find((x) => x.id === deliveryId);
    if (!d) throw new Error("no such delivery");
    d.notes.push(...notes.map((note) => ({ ...note, id: randomUUID() })));
  }

  async findNote(deliveryId: string, noteId: string): Promise<NoteRow | null> {
    const note = materialTables.deliveries
      .find((x) => x.id === deliveryId)
      ?.notes.find((n) => n.id === noteId);
    return note ? { ...note } : null;
  }

  async deleteNote(noteId: string): Promise<boolean> {
    for (const d of materialTables.deliveries) {
      const at = d.notes.findIndex((n) => n.id === noteId);
      if (at >= 0) {
        d.notes.splice(at, 1);
        return true;
      }
    }
    return false;
  }

  async countNotes(deliveryId: string): Promise<number> {
    return materialTables.deliveries.find((x) => x.id === deliveryId)?.notes.length ?? 0;
  }

  async delete(id: string, version: number): Promise<boolean> {
    const at = materialTables.deliveries.findIndex((d) => d.id === id && d.version === version);
    if (at < 0) return false;
    materialTables.deliveries.splice(at, 1);
    return true;
  }

  async countsOfVilla(villaId: string): Promise<DeliveryCountRow[]> {
    const counts = new Map<FactoryTypeValue, DeliveryCountRow>();
    for (const row of materialTables.deliveries.filter((d) => d.villaId === villaId).map(deliveryRow)) {
      const c = counts.get(row.factory.type) ?? { type: row.factory.type, deliveries: 0, withNote: 0 };
      c.deliveries += 1;
      c.withNote += row.notes.length > 0 ? 1 : 0;
      counts.set(row.factory.type, c);
    }
    return [...counts.values()];
  }
}

type Pair = BalanceRow & { sortOrder: number };

// Every villa against every catalog item, as the SQL builds it.
function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const villa of villaTables.villas) {
    for (const item of materialTables.items) {
      const own = materialTables.requirements.find((r) => r.villaId === villa.id && r.itemId === item.id);
      const brought = materialTables.deliveries.filter(
        (d) => d.villaId === villa.id && d.lines.some((l) => l.itemId === item.id),
      );
      out.push({
        villaId: villa.id,
        villaNumber: villa.villaNumber,
        itemId: item.id,
        name: item.name,
        unit: item.unit,
        type: item.type,
        sortOrder: item.sortOrder,
        required: own ? own.quantity : item.requiredPerVilla,
        custom: own !== undefined,
        delivered: round2(
          brought.reduce((sum, d) => sum + (d.lines.find((l) => l.itemId === item.id)?.quantity ?? 0), 0),
        ),
        deliveries: brought.length,
        withNote: brought.filter((d) => d.notes.length > 0).length,
      });
    }
  }
  return out;
}

function matches(p: BalanceRow, f: BalanceFilters): boolean {
  return (
    (p.required > 0 || p.delivered > 0) &&
    (!f.villaId || p.villaId === f.villaId) &&
    (!f.itemId || p.itemId === f.itemId) &&
    (!f.type || p.type === f.type) &&
    (!f.search || p.villaNumber.toLowerCase().includes(f.search.toLowerCase())) &&
    (f.status !== "PENDING" || p.required > p.delivered) &&
    (f.status !== "COMPLETE" || p.required === p.delivered) &&
    (f.status !== "OVER" || p.required < p.delivered)
  );
}

function withoutOrder(pair: Pair): BalanceRow {
  const { sortOrder, ...row } = pair;
  void sortOrder;
  return row;
}

export class InMemoryBalanceRepository implements BalanceRepository {
  async list(
    params: BalanceFilters & { skip: number; take: number },
  ): Promise<{ rows: BalanceRow[]; total: number; totals: BalanceTotalRow[] }> {
    const rows = pairs()
      .filter((p) => matches(p, params))
      .sort(
        (a, b) =>
          a.villaNumber.localeCompare(b.villaNumber) ||
          typeOrder(a.type) - typeOrder(b.type) ||
          a.sortOrder - b.sortOrder ||
          a.name.localeCompare(b.name),
      );
    const totals = new Map<string, BalanceTotalRow & { sortOrder: number; order: number }>();
    for (const row of rows) {
      const t = totals.get(row.itemId) ?? {
        itemId: row.itemId,
        name: row.name,
        unit: row.unit,
        type: row.type,
        sortOrder: row.sortOrder,
        order: typeOrder(row.type),
        balance: 0,
        villas: 0,
      };
      t.balance = round2(t.balance + Math.max(row.required - row.delivered, 0));
      t.villas += row.required > row.delivered ? 1 : 0;
      totals.set(row.itemId, t);
    }
    return {
      rows: rows.slice(params.skip, params.skip + params.take).map(withoutOrder),
      total: rows.length,
      totals: [...totals.values()]
        .filter((t) => t.balance > 0)
        .sort((a, b) => a.order - b.order || a.sortOrder - b.sortOrder)
        .map((t) => ({
          itemId: t.itemId,
          name: t.name,
          unit: t.unit,
          type: t.type,
          balance: t.balance,
          villas: t.villas,
        })),
    };
  }

  async ofVilla(villaId: string): Promise<BalanceRow[]> {
    return pairs()
      .filter((p) => matches(p, { villaId }))
      .sort(
        (a, b) =>
          typeOrder(a.type) - typeOrder(b.type) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      )
      .map(withoutOrder);
  }

  async setRequirements(
    villaId: string,
    items: { itemId: string; quantity: number | null }[],
  ): Promise<void> {
    for (const { itemId, quantity } of items) {
      materialTables.requirements = materialTables.requirements.filter(
        (r) => !(r.villaId === villaId && r.itemId === itemId),
      );
      if (quantity !== null) materialTables.requirements.push({ villaId, itemId, quantity });
    }
  }
}
