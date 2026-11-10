import { z } from "zod";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { prisma } from "../../../core/database/prisma.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import {
  IMPORT_TRANSACTION_TIMEOUT_MS,
  ImportBatchRepository,
  ImportRunner,
  type ImportDefinition,
  type ImportOutcome,
} from "../../../core/imports/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import { FACTORY_TYPES, type FactoryTypeValue } from "../../../shared/constants/enums.js";
import { formatDate } from "../../../shared/export/format.js";
import { writePdf } from "../../../shared/export/pdf.js";
import {
  CONTENT_TYPES,
  EXPORT_MAX_ROWS,
  type ExportColumn,
  type ExportDocument,
  type ExportFormat,
  type ExportRow,
  type ExportWriter,
} from "../../../shared/export/types.js";
import { writeXlsx } from "../../../shared/export/xlsx.js";
import {
  buildTemplate,
  buildVillaIndex,
  dateCell,
  decimalCell,
  normalizeText,
  resolveVilla,
  RowParser,
  textCell,
  textOrNumberCell,
  villaNumberChoices,
  type CellResult,
  type IgnoredColumn,
  type ImportColumn,
  type RawCell,
  type TemplateSpec,
  type VillaIndex,
} from "../../../shared/import/index.js";
import { MAX_LIMIT } from "../../../shared/query/pagination.js";
import type { BalanceRowDto, MaterialDeliveryDto } from "../dto/materials.dto.js";
import { DeliveriesRepository, type ImportCatalog } from "../repository/deliveries.repository.js";
import type { ListBalanceQuery, ListDeliveriesQuery } from "../validators/materials.validators.js";
import { DeliveriesService } from "./deliveries.service.js";

const TYPE_LABELS: Record<FactoryTypeValue, string> = { SWITCHGEAR: "Switchgears", CABLE: "Cable" };
const STATUS_LABELS = { PENDING: "Not delivered", COMPLETE: "Delivered", OVER: "Over-delivered" } as const;

// The headers of the workbook and of the import: the same words, so an exported file can be imported again.
export const MATERIAL_TITLES = {
  villaNumber: "Villa Number",
  factory: "Factory",
  material: "Material",
  quantity: "Quantity",
  deliveryDate: "Delivery Date",
  noteNumber: "Delivery Note No.",
  type: "Type",
  unit: "Unit",
  noteFiles: "Delivery Note Files",
  createdAt: "Created (UTC)",
  required: "Required",
  delivered: "Delivered",
  balance: "Balance",
  status: "Status",
} as const;

const T = MATERIAL_TITLES;
const asDay = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

// ---- the deliveries workbook and PDF: one row per material of a delivery ----

const DELIVERY_COLUMNS: ExportColumn[] = [
  { key: T.villaNumber, title: T.villaNumber, kind: "text" },
  { key: T.factory, title: T.factory, kind: "text" },
  { key: T.material, title: T.material, kind: "text" },
  { key: T.quantity, title: T.quantity, kind: "decimal" },
  { key: T.deliveryDate, title: T.deliveryDate, kind: "date" },
  { key: T.noteNumber, title: T.noteNumber, kind: "text" },
  { key: T.type, title: T.type, kind: "text" },
  { key: T.unit, title: T.unit, kind: "text" },
  { key: T.noteFiles, title: T.noteFiles, kind: "text" },
  { key: T.createdAt, title: T.createdAt, kind: "datetime" },
];

// The PDF reads like a delivery register: the date first.
const DELIVERY_PDF_COLUMNS: ExportColumn[] = [
  { key: T.deliveryDate, title: T.deliveryDate, kind: "date" },
  { key: T.villaNumber, title: T.villaNumber, kind: "text" },
  { key: T.type, title: T.type, kind: "text" },
  { key: T.factory, title: T.factory, kind: "text" },
  { key: T.material, title: T.material, kind: "text" },
  { key: T.quantity, title: T.quantity, kind: "decimal" },
  { key: T.unit, title: T.unit, kind: "text" },
  { key: T.noteNumber, title: T.noteNumber, kind: "text" },
  { key: T.noteFiles, title: T.noteFiles, kind: "text" },
];

function deliveryRows(item: MaterialDeliveryDto): ExportRow[] {
  const files = item.deliveryNotes.map((note) => note.name).join(", ");
  return item.lines.map((line) => ({
    [T.villaNumber]: item.villa.villaNumber,
    [T.factory]: item.factory.name,
    [T.material]: line.item.name,
    [T.quantity]: line.quantity,
    [T.deliveryDate]: asDay(item.deliveryDate),
    [T.noteNumber]: item.noteNumber ?? "",
    [T.type]: TYPE_LABELS[item.factory.type],
    [T.unit]: line.item.unit,
    [T.noteFiles]: files || "None",
    [T.createdAt]: new Date(item.createdAt),
  }));
}

// ---- the balance workbook and PDF: one row per villa and material ----

const BALANCE_COLUMNS: ExportColumn[] = [
  { key: T.villaNumber, title: T.villaNumber, kind: "text" },
  { key: T.type, title: T.type, kind: "text" },
  { key: T.material, title: T.material, kind: "text" },
  { key: T.required, title: T.required, kind: "decimal" },
  { key: T.delivered, title: T.delivered, kind: "decimal" },
  { key: T.balance, title: T.balance, kind: "decimal" },
  { key: T.unit, title: T.unit, kind: "text" },
  { key: T.status, title: T.status, kind: "text" },
];

const balanceRow = (row: BalanceRowDto): ExportRow => ({
  [T.villaNumber]: row.villa.villaNumber,
  [T.type]: TYPE_LABELS[row.item.type],
  [T.material]: row.item.name,
  [T.required]: row.required,
  [T.delivered]: row.delivered,
  [T.balance]: row.balance,
  [T.unit]: row.item.unit,
  [T.status]: STATUS_LABELS[row.status],
});

// The filters, one line each, for the top of the PDF.
function describe(query: Record<string, unknown>, names: Record<string, string>): string[] {
  return Object.entries(names)
    .filter(([key]) => query[key] !== undefined && query[key] !== "")
    .map(([key, label]) => {
      const value = query[key];
      return `${label}: ${value instanceof Date ? formatDate(value) : String(value)}`;
    });
}

const tooLarge = (ctx: RequestContext): AppError =>
  new AppError(422, t(ctx.locale, "errors.exportTooLarge"), "EXPORT_TOO_LARGE");

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ---- the import: one row per material; rows of the same delivery (villa, factory, date and note number) are one delivery ----

const villaNumber = z.string().trim().min(1, { error: "validation.required" });
const name = z
  .string()
  .trim()
  .min(1, { error: "validation.required" })
  .max(200, { error: "validation.textLength" });
const noteNumber = z.string().trim().max(50, { error: "validation.noteNumberLength" });

export const MATERIAL_IMPORT_COLUMNS = [
  {
    header: T.villaNumber,
    kind: "text",
    required: true,
    description: "The villa number, exactly as it is in the system.",
    example: "EX-000",
  },
  {
    header: T.factory,
    kind: "text",
    required: true,
    description:
      "The factory, as it is in the Factories list (its type decides which materials it can deliver).",
    example: "Gulf Switchgear",
  },
  {
    header: T.material,
    kind: "text",
    required: true,
    description: "The material, as it is in the Materials list, of the same type as the factory.",
    example: "MSB Box",
  },
  {
    header: T.quantity,
    kind: "decimal",
    required: true,
    description: "How much came, more than 0, with at most two decimals, in the material's unit.",
    example: "1",
  },
  {
    header: T.deliveryDate,
    kind: "date",
    required: true,
    description: "The day of the delivery, written YYYY-MM-DD, or a date cell.",
    example: "2026-11-10",
  },
  {
    header: T.noteNumber,
    kind: "text",
    required: false,
    description:
      "The delivery note number. Rows with the same villa, factory, date and note number are one delivery with several materials.",
    example: "DN-1024",
  },
] as const satisfies readonly ImportColumn[];

// What the workbook adds after those columns. A file that carries them is imported as it is: they are not read.
export const MATERIAL_IGNORED_COLUMNS = [
  { header: T.type, kind: "text" },
  { header: T.unit, kind: "text" },
  { header: T.noteFiles, kind: "text" },
  { header: T.createdAt, kind: "datetime" },
] as const satisfies readonly IgnoredColumn[];

const TEMPLATE: TemplateSpec & { fileName: string } = {
  sheetName: "Material deliveries",
  plural: "material deliveries",
  fileName: "material-deliveries-import-template.xlsx",
  columns: MATERIAL_IMPORT_COLUMNS,
};

export type MaterialRowInput = {
  villaId: string;
  factoryId: string;
  itemId: string;
  quantity: number;
  deliveryDate: Date;
  noteNumber: string | null;
};

export type MaterialLookups = {
  villas: VillaIndex<{ id: string; villaNumber: string }>;
  // The factories by name (ignoring case and spaces); two with the same name are both kept, so the match can be ambiguous.
  factories: ReadonlyMap<string, readonly { id: string; type: FactoryTypeValue }[]>;
  // The materials by type, then by name.
  items: ReadonlyMap<FactoryTypeValue, ReadonlyMap<string, string>>;
};

export function buildMaterialLookups(
  villas: readonly { id: string; villaNumber: string }[],
  catalog: ImportCatalog,
): MaterialLookups {
  const factories = new Map<string, { id: string; type: FactoryTypeValue }[]>();
  for (const f of catalog.factories) {
    const key = normalizeText(f.name);
    factories.set(key, [...(factories.get(key) ?? []), { id: f.id, type: f.type }]);
  }
  const items = new Map<FactoryTypeValue, Map<string, string>>(
    FACTORY_TYPES.map((type) => [type, new Map()]),
  );
  for (const item of catalog.items) items.get(item.type)?.set(normalizeText(item.name), item.id);
  return { villas: buildVillaIndex(villas), factories, items };
}

export function parseMaterialRow(
  cells: Readonly<Record<string, RawCell>>,
  lookups: MaterialLookups,
): { value: MaterialRowInput | undefined; issues: RowParser["issues"] } {
  const cell = (header: string): RawCell => cells[header] ?? null;
  const parser = new RowParser();
  const take = <V>(header: string, result: CellResult<V>): V | undefined =>
    parser.take(header, cell(header), result);

  const villaText = take(
    T.villaNumber,
    textOrNumberCell(cell(T.villaNumber), villaNumber, { required: true }),
  );
  const factoryText = take(T.factory, textCell(cell(T.factory), name, { required: true }));
  const materialText = take(T.material, textCell(cell(T.material), name, { required: true }));
  const quantity = take(
    T.quantity,
    decimalCell(cell(T.quantity), {
      required: true,
      scale: 2,
      max: 9_999_999_999.99,
      key: "validation.quantityInvalid",
    }),
  );
  const deliveryDate = take(T.deliveryDate, dateCell(cell(T.deliveryDate), { required: true }));
  const note = take(T.noteNumber, textCell(cell(T.noteNumber), noteNumber, { required: false }));

  const villa = resolveVilla(parser.issues, lookups.villas, T.villaNumber, villaText, cell(T.villaNumber));

  let factory: { id: string; type: FactoryTypeValue } | undefined;
  if (factoryText !== undefined) {
    const found = lookups.factories.get(normalizeText(factoryText)) ?? [];
    if (found.length === 1) factory = found[0];
    else {
      parser.issues.push({
        column: T.factory,
        code: found.length === 0 ? "REFERENCE_NOT_FOUND" : "AMBIGUOUS_REFERENCE",
        key: found.length === 0 ? "import.factoryNotFound" : "import.referenceAmbiguous",
        value: cell(T.factory),
      });
    }
  }

  let itemId: string | undefined;
  if (materialText !== undefined && factory !== undefined) {
    itemId = lookups.items.get(factory.type)?.get(normalizeText(materialText));
    if (itemId === undefined) {
      const otherType = FACTORY_TYPES.some(
        (type) => type !== factory.type && lookups.items.get(type)?.has(normalizeText(materialText)),
      );
      parser.issues.push({
        column: T.material,
        code: otherType ? "INVALID_VALUE" : "REFERENCE_NOT_FOUND",
        key: otherType ? "import.materialWrongType" : "import.materialNotFound",
        value: cell(T.material),
      });
    }
  }

  if (
    !parser.ok ||
    villa === undefined ||
    factory === undefined ||
    itemId === undefined ||
    quantity === undefined ||
    deliveryDate === undefined
  ) {
    return { value: undefined, issues: parser.issues };
  }
  return {
    value: {
      villaId: villa.id,
      factoryId: factory.id,
      itemId,
      quantity,
      deliveryDate,
      noteNumber: note && note.length > 0 ? note : null,
    },
    issues: [],
  };
}

const importDataChanged = (ctx: RequestContext): AppError =>
  new AppError(409, t(ctx.locale, "errors.importDataChanged"), "IMPORT_DATA_CHANGED");

// The rows that make one delivery: the same villa, factory, day and note number. The same material twice in one delivery is
// added up into one line.
export function groupDeliveries(rows: readonly MaterialRowInput[]) {
  const groups = new Map<
    string,
    Omit<MaterialRowInput, "itemId" | "quantity"> & { lines: Map<string, number>; rows: number }
  >();
  for (const row of rows) {
    const key = [row.villaId, row.factoryId, row.deliveryDate.toISOString(), row.noteNumber ?? ""].join(
      "\u0000",
    );
    const group = groups.get(key) ?? {
      villaId: row.villaId,
      factoryId: row.factoryId,
      deliveryDate: row.deliveryDate,
      noteNumber: row.noteNumber,
      lines: new Map<string, number>(),
      rows: 0,
    };
    group.rows += 1;
    group.lines.set(row.itemId, Math.round(((group.lines.get(row.itemId) ?? 0) + row.quantity) * 100) / 100);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    villaId: group.villaId,
    factoryId: group.factoryId,
    deliveryDate: group.deliveryDate,
    noteNumber: group.noteNumber,
    lines: [...group.lines].map(([itemId, quantity]) => ({ itemId, quantity })),
    rows: group.rows,
  }));
}

export function materialsImportDefinition(
  repository: DeliveriesRepository,
  actor: Actor,
  ctx: RequestContext,
): ImportDefinition<MaterialRowInput, MaterialLookups, false> {
  return {
    entity: "MaterialDelivery",
    action: "material_delivery.import",
    sheetName: TEMPLATE.sheetName,
    plural: TEMPLATE.plural,
    fileName: TEMPLATE.fileName,
    columns: MATERIAL_IMPORT_COLUMNS,
    ignoredColumns: MATERIAL_IGNORED_COLUMNS,
    loadLookups: async (db) => {
      // A row is saved for the acting user; one who is gone cannot import.
      if (!(await repository.userExists(actor.id, db))) {
        throw new AppError(401, t(ctx.locale, "errors.unauthorized"), "UNAUTHORIZED");
      }
      return buildMaterialLookups(await repository.importVillas(db), await repository.importCatalog(db));
    },
    parseRow: parseMaterialRow,
    insert: async (rows, db) => {
      // The villas first, shared and in the order of their ids, so this takes turns with a delete of a villa.
      const villaIds = [...new Set(rows.map((row) => row.villaId))].sort();
      const existing = await repository.lockVillasShared(villaIds, db);
      if (rows.some((row) => !existing.has(row.villaId))) throw importDataChanged(ctx);
      // One id per row, the delivery it went into, so the report counts the rows that were imported.
      const ids: string[] = [];
      for (const { rows: count, ...delivery } of groupDeliveries(rows)) {
        const created = await repository.create(delivery, db);
        for (let n = 0; n < count; n++) ids.push(created.id);
      }
      return ids;
    },
  };
}

export class MaterialsTransferService {
  constructor(
    private readonly deliveries = new DeliveriesService(),
    private readonly repository = new DeliveriesRepository(),
    private readonly runner = new ImportRunner(new ImportBatchRepository(), (work) =>
      repository.transaction(work, { timeout: IMPORT_TRANSACTION_TIMEOUT_MS }),
    ),
    private readonly writers: Record<ExportFormat, ExportWriter> = { xlsx: writeXlsx, pdf: writePdf },
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Every delivery of the filters, one row per material, with its delivery note files.
  async exportDeliveries(
    format: ExportFormat,
    query: ListDeliveriesQuery,
    actor: Actor,
    ctx: RequestContext,
  ) {
    const first = await this.deliveries.list({ ...query, page: 1, limit: MAX_LIMIT });
    if (first.meta.total > EXPORT_MAX_ROWS) throw tooLarge(ctx);
    const fetch = async (page: number) =>
      (await this.deliveries.list({ ...query, page, limit: MAX_LIMIT })).items;
    return this.produce(
      {
        format,
        action: "export.material-deliveries",
        entity: "MaterialDelivery",
        title: "Material deliveries",
        sheet: "Material deliveries",
        file: "material-deliveries",
        columns: format === "pdf" ? DELIVERY_PDF_COLUMNS : DELIVERY_COLUMNS,
        filters: describe(query, {
          search: "Search",
          type: "Type",
          deliveryFrom: "From",
          deliveryTo: "To",
          hasNote: "With delivery note",
        }),
        applied: query,
        total: first.meta.total,
        rows: this.pages(first.items, first.meta.total, fetch, deliveryRows),
      },
      actor,
      ctx,
    );
  }

  // What every villa needs, received and still waits for, per material.
  async exportBalance(format: ExportFormat, query: ListBalanceQuery, actor: Actor, ctx: RequestContext) {
    const first = await this.deliveries.balanceList({ ...query, page: 1, limit: MAX_LIMIT });
    if (first.meta.total > EXPORT_MAX_ROWS) throw tooLarge(ctx);
    const fetch = async (page: number) =>
      (await this.deliveries.balanceList({ ...query, page, limit: MAX_LIMIT })).items;
    const summary: [string, string][] = first.totals.map((row) => [
      `Not delivered: ${row.item.name}`,
      `${row.balance} ${row.item.unit} (${row.villas} villas)`,
    ]);
    return this.produce(
      {
        format,
        action: "export.material-balance",
        entity: "MaterialItem",
        title: "Material balance",
        sheet: "Material balance",
        file: "material-balance",
        columns: BALANCE_COLUMNS,
        filters: describe(query, { search: "Villa", type: "Type", status: "Status" }),
        applied: query,
        total: first.meta.total,
        summary,
        rows: this.pages(first.items, first.meta.total, fetch, (row) => [balanceRow(row)]),
      },
      actor,
      ctx,
    );
  }

  async template(): Promise<{ fileName: string; bytes: Buffer }> {
    const [villas, catalog] = await Promise.all([
      this.repository.importVillas(),
      this.repository.importCatalog(),
    ]);
    return {
      fileName: TEMPLATE.fileName,
      bytes: await buildTemplate({
        ...TEMPLATE,
        lists: {
          [T.villaNumber]: villaNumberChoices(villas),
          [T.factory]: [...new Set(catalog.factories.map((f) => f.name))].sort(),
          [T.material]: [...new Set(catalog.items.map((i) => i.name))].sort(),
        },
      }),
    };
  }

  importFile(
    actor: Actor,
    file: { name: string; bytes: Buffer },
    dryRun: boolean,
    ctx: RequestContext,
  ): Promise<ImportOutcome> {
    return this.runner.run(materialsImportDefinition(this.repository, actor, ctx), {
      file,
      dryRun,
      actor,
      ctx,
    });
  }

  // The audit entry is written before the file, so an export always leaves a trace, whatever happens to the download.
  private async produce(
    spec: {
      format: ExportFormat;
      action: string;
      entity: string;
      title: string;
      sheet: string;
      file: string;
      columns: ExportColumn[];
      filters: string[];
      applied: object;
      total: number;
      summary?: [string, string][];
      rows: AsyncIterable<ExportRow[]>;
    },
    actor: Actor,
    ctx: RequestContext,
  ) {
    await prisma.$transaction((tx) =>
      audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: spec.action,
          entity: spec.entity,
          after: { format: spec.format, filters: spec.applied, rowCount: spec.total },
        }),
      ),
    );
    const generatedAt = this.now();
    const document: ExportDocument = {
      title: spec.title,
      sheetName: spec.sheet,
      generatedAt,
      filters: spec.filters,
      columns: spec.columns,
      rows: spec.rows,
      ...(spec.summary && spec.summary.length > 0 && { summary: spec.summary }),
    };
    const writer = this.writers[spec.format];
    return {
      filename: `asico-${spec.file}-${formatDate(generatedAt)}.${spec.format}`,
      contentType: CONTENT_TYPES[spec.format],
      write: (out: Parameters<ExportWriter>[1]) => writer(document, out),
    };
  }

  // The rows, a page at a time; the loop lets the server handle other requests between pages.
  private async *pages<Item>(
    first: Item[],
    total: number,
    fetch: (page: number) => Promise<Item[]>,
    toRows: (item: Item) => ExportRow[],
  ): AsyncGenerator<ExportRow[]> {
    yield first.flatMap(toRows);
    const pages = Math.ceil(total / MAX_LIMIT);
    for (let page = 2; page <= pages; page++) {
      await nextTick();
      const items = await fetch(page);
      if (items.length === 0) return;
      yield items.flatMap(toRows);
    }
  }
}
