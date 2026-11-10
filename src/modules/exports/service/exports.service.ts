import type { Writable } from "node:stream";
import { audit, withMeta } from "../../../core/audit/audit.js";
import { prisma } from "../../../core/database/prisma.js";
import { AppError } from "../../../core/errors/AppError.js";
import { t } from "../../../core/i18n/index.js";
import type { Actor, RequestContext } from "../../../core/middleware/requestContext.js";
import {
  formatBoolean,
  formatDate,
  formatMoney,
  formatPercent,
  moneyCell,
} from "../../../shared/export/format.js";
import {
  COLUMN_TITLES,
  EXPORT_NAMES,
  PARTY_STATUS_LABELS,
  PRIORITY_LABELS,
  REPORT,
  SITE_REPORT_TYPE_LABELS,
  SMALL_WORK_STATUS_LABELS,
  SUMMARY_LABELS,
  WEATHER_LABELS,
  WORK_STATUS_LABELS,
} from "../../../shared/export/labels.js";
import { writePdf } from "../../../shared/export/pdf.js";
import {
  CONTENT_TYPES,
  EXPORT_MAX_ROWS,
  type ColumnKind,
  type ExportColumn,
  type ExportDocument,
  type ExportFormat,
  type ExportRow,
  type ExportWriter,
} from "../../../shared/export/types.js";
import { writeXlsx } from "../../../shared/export/xlsx.js";
import { MAX_LIMIT } from "../../../shared/query/pagination.js";
import { AreasService, type AreaDto, type ListAreasQuery } from "../../areas/index.js";
import {
  actionLabel,
  AuditService,
  entityLabel,
  type AuditLogListItemDto,
  type ListAuditLogsQuery,
} from "../../audit/index.js";
import {
  CivilEngineersService,
  type CivilEngineerDto,
  type ListCivilEngineersQuery,
} from "../../civil-engineers/index.js";
import {
  CONTRACTOR_IGNORED_COLUMNS,
  CONTRACTOR_IMPORT_COLUMNS,
  ContractorsService,
  type ContractorDto,
  type ContractorSummaryQuery,
} from "../../contractors/index.js";
import type { ListContractorsQuery } from "../../contractors/index.js";
import {
  ElectricalEngineersService,
  type ElectricalEngineerDto,
  type ListElectricalEngineersQuery,
} from "../../electrical-engineers/index.js";
import {
  DAILY_LABOUR_IGNORED_COLUMNS,
  DAILY_LABOUR_IMPORT_COLUMNS,
  DailyLabourService,
  type DailyLabourDto,
  type ListDailyLabourQuery,
} from "../../daily-labour/index.js";
import {
  DAILY_REPORT_IGNORED_COLUMNS,
  DAILY_REPORT_IMPORT_COLUMNS,
  DailyReportsService,
  type DailyReportDto,
  type ListDailyReportsQuery,
} from "../../daily-reports/index.js";
import {
  OPEN_WORK_IGNORED_COLUMNS,
  OPEN_WORK_IMPORT_COLUMNS,
  OpenWorksService,
  type ListOpenWorksQuery,
  type OpenWorkDto,
} from "../../open-works/index.js";
import {
  SITE_REPORT_IGNORED_COLUMNS,
  SITE_REPORT_IMPORT_COLUMNS,
  SiteReportsService,
  type ListSiteReportsQuery,
  type SiteReportDto,
} from "../../site-reports/index.js";
import {
  SMALL_WORK_IGNORED_COLUMNS,
  SMALL_WORK_IMPORT_COLUMNS,
  SmallWorksService,
  type ListSmallWorksQuery,
  type SmallWorkDto,
} from "../../small-works/index.js";
import {
  VILLA_IGNORED_COLUMNS,
  VILLA_IMPORT_COLUMNS,
  VillasService,
  type ListVillasQuery,
  type VillaListItemDto,
  type VillaReferences,
} from "../../villas/index.js";
import type { ParsedExport } from "../validators/exports.validators.js";
import { appliedFilters, describeFilters } from "./filters.js";

// A file ready to be written: the headers' values, and the function that streams it.
export type ExportResult = {
  filename: string;
  contentType: string;
  write: (out: Writable) => Promise<{ rows: number }>;
};

type Page<Item, Extra = undefined> = { items: Item[]; total: number; extra: Extra };

type Definition<Item, Extra = undefined> = {
  names: { title: string; sheet: string; file: string };
  action: string;
  entity: string;
  entityId?: string;
  columns: ExportColumn[];
  filters: string[];
  applied: Record<string, unknown>;
  // The PDF of a resource that has an import shows its own, shorter columns (the workbook has those of the import).
  pdf?: { columns: ExportColumn[]; toRow: (item: Item) => ExportRow };
  // One page of the list, at the list's own biggest size, from the module's own list service.
  fetch: (page: number) => Promise<Page<Item, Extra>>;
  toRow: (item: Item) => ExportRow;
  summary?: (first: Page<Item, Extra>) => [string, string][];
};

const column = (key: string, title: string, kind: ColumnKind): ExportColumn => ({ key, title, kind });

const asDate = (iso: string | null): Date | null => (iso === null ? null : new Date(iso));

// The workbook of a resource that has an import: the columns of the import first (its template), then the ones the import
// reads past. A column's key is its header, so a row is written under the header the import reads it from. An empty cell is
// null.
const sheetColumns = (
  importable: readonly { header: string; kind: ColumnKind }[],
  ignored: readonly { header: string; kind: ColumnKind }[],
): ExportColumn[] => [...importable, ...ignored].map(({ header, kind }) => column(header, header, kind));

const H = COLUMN_TITLES;
const orNull = (text: string | null | undefined): string | null => text ?? null;

const VILLA_COLUMNS = {
  villaNumber: column("villaNumber", COLUMN_TITLES.villaNumber, "text"),
  ownerName: column("ownerName", COLUMN_TITLES.ownerName, "text"),
  area: column("area", COLUMN_TITLES.area, "text"),
  block: column("block", COLUMN_TITLES.block, "text"),
  plot: column("plot", COLUMN_TITLES.plot, "text"),
  civilEngineer: column("civilEngineer", COLUMN_TITLES.civilEngineer, "text"),
  electricalEngineer: column("electricalEngineer", COLUMN_TITLES.electricalEngineer, "text"),
  contractor: column("contractor", COLUMN_TITLES.contractor, "text"),
  startDate: column("startDate", COLUMN_TITLES.startDate, "date"),
  targetDate: column("targetDate", COLUMN_TITLES.targetDate, "date"),
  budget: column("budget", COLUMN_TITLES.budget, "text"),
  // Text, like the budget: the export has no decimal column kind.
  progress: column("progress", COLUMN_TITLES.progress, "text"),
  // Yes or No, and the day it was marked (empty when it is not).
  createdAt: column("createdAt", COLUMN_TITLES.createdAt, "datetime"),
};

const VILLAS_PDF_COLUMNS = Object.values(VILLA_COLUMNS);
// The budget is shown with the decimals of the currency in its own row.
const VILLAS_SHEET_COLUMNS = sheetColumns(VILLA_IMPORT_COLUMNS, VILLA_IGNORED_COLUMNS).map((column) =>
  column.key === H.budget ? { ...column, currencyKey: H.currency } : column,
);

function villaPdfRow(item: VillaListItemDto): ExportRow {
  return {
    villaNumber: item.villaNumber,
    ownerName: item.ownerName ?? "",
    area: item.area,
    block: item.block,
    plot: item.plot,
    civilEngineer: item.civilEngineer.name,
    electricalEngineer: item.electricalEngineer?.name ?? "",
    contractor: item.contractor?.name ?? "",
    startDate: asDate(item.startDate),
    targetDate: asDate(item.targetDate),
    budget: formatMoney(item.budgetMinor, item.currency),
    progress: formatPercent(item.progress),
    createdAt: new Date(item.createdAt),
  };
}

// The areas and the parties are written as the import reads them (see VillaReferences). The budget is a number in major units.
function villaSheetRow(item: VillaListItemDto, references: VillaReferences): ExportRow {
  return {
    [H.villaNumber]: item.villaNumber,
    [H.ownerName]: orNull(item.ownerName),
    [H.area]: references.area({ id: item.areaId, name: item.area }),
    [H.block]: item.block,
    [H.plot]: item.plot,
    [H.contractor]: item.contractor === null ? null : references.party("contractor", item.contractor),
    [H.electricalEngineer]:
      item.electricalEngineer === null
        ? null
        : references.party("electricalEngineer", item.electricalEngineer),
    [H.civilEngineer]: references.party("civilEngineer", item.civilEngineer),
    [H.startDate]: asDate(item.startDate),
    [H.targetDate]: asDate(item.targetDate),
    [H.budget]: moneyCell(item.budgetMinor, item.currency),
    [H.currency]: item.budgetMinor === null ? null : item.currency,
    [H.progress]: formatPercent(item.progress),
    [H.createdAt]: new Date(item.createdAt),
  };
}

const PEOPLE_COLUMNS = [
  column("name", COLUMN_TITLES.name, "text"),
  column("phone", COLUMN_TITLES.phone, "text"),
  column("email", COLUMN_TITLES.email, "text"),
  column("status", COLUMN_TITLES.status, "text"),
  column("villaCount", COLUMN_TITLES.villaCount, "integer"),
  column("createdAt", COLUMN_TITLES.createdAt, "datetime"),
];

function personRow(item: ContractorDto | CivilEngineerDto | ElectricalEngineerDto): ExportRow {
  return {
    name: item.name,
    phone: item.phone,
    email: item.email ?? "",
    status: PARTY_STATUS_LABELS[item.status],
    villaCount: item.villaCount,
    createdAt: new Date(item.createdAt),
  };
}

const CONTRACTOR_SHEET_COLUMNS = sheetColumns(CONTRACTOR_IMPORT_COLUMNS, CONTRACTOR_IGNORED_COLUMNS);

function contractorSheetRow(item: ContractorDto): ExportRow {
  return {
    [H.name]: item.name,
    [H.phone]: item.phone,
    [H.email]: orNull(item.email),
    [H.status]: PARTY_STATUS_LABELS[item.status],
    [H.villaCount]: item.villaCount,
    [H.createdAt]: new Date(item.createdAt),
  };
}

const AREA_COLUMNS = [
  column("name", COLUMN_TITLES.name, "text"),
  column("city", COLUMN_TITLES.city, "text"),
  column("villaCount", COLUMN_TITLES.villaCount, "integer"),
  column("createdAt", COLUMN_TITLES.createdAt, "datetime"),
];

function areaRow(item: AreaDto): ExportRow {
  return {
    name: item.name,
    city: item.city,
    villaCount: item.villaCount,
    createdAt: new Date(item.createdAt),
  };
}

const AUDIT_COLUMNS = [
  column("time", COLUMN_TITLES.time, "datetime"),
  column("actorName", COLUMN_TITLES.actorName, "text"),
  column("actorEmail", COLUMN_TITLES.actorEmail, "text"),
  column("action", COLUMN_TITLES.action, "text"),
  column("entity", COLUMN_TITLES.entity, "text"),
  column("entityId", COLUMN_TITLES.entityId, "text"),
  column("ip", COLUMN_TITLES.ip, "text"),
  column("userAgent", COLUMN_TITLES.userAgent, "text"),
  column("requestId", COLUMN_TITLES.requestId, "text"),
];

function auditRow(item: AuditLogListItemDto): ExportRow {
  return {
    time: new Date(item.createdAt),
    actorName: item.actor?.name ?? REPORT.system,
    actorEmail: item.actor?.email ?? "",
    // The words a person reads, in English like the rest of the file, from the stored codes (not from the list item,
    // whose labels follow the language of whoever asked).
    action: actionLabel(item.action, "en"),
    entity: entityLabel(item.entityCode, "en"),
    entityId: item.entityId ?? "",
    ip: item.ip ?? "",
    userAgent: item.userAgent ?? "",
    requestId: item.requestId ?? "",
  };
}

const OPEN_WORK_PDF_COLUMNS = [
  column("villaNumber", COLUMN_TITLES.villaNumber, "text"),
  column("location", COLUMN_TITLES.location, "text"),
  column("elecPhase", COLUMN_TITLES.elecPhase, "text"),
  column("status", COLUMN_TITLES.status, "text"),
  column("priority", COLUMN_TITLES.priority, "text"),
  column("progress", COLUMN_TITLES.progress, "text"),
  column("contractor", COLUMN_TITLES.contractor, "text"),
  column("startDate", COLUMN_TITLES.startDate, "date"),
  column("endDate", COLUMN_TITLES.endDate, "date"),
  column("overdue", COLUMN_TITLES.overdue, "text"),
];

const OPEN_WORK_SHEET_COLUMNS = sheetColumns(OPEN_WORK_IMPORT_COLUMNS, OPEN_WORK_IGNORED_COLUMNS);

function openWorkSheetRow(item: OpenWorkDto): ExportRow {
  return {
    [H.villaNumber]: item.villa.villaNumber,
    [H.elecPhase]: item.elecPhase.name,
    [H.status]: WORK_STATUS_LABELS[item.status],
    [H.priority]: PRIORITY_LABELS[item.priority],
    [H.progress]: item.progress,
    [H.contractor]: item.contractor?.name ?? null,
    [H.startDate]: asDate(item.startDate),
    [H.endDate]: asDate(item.endDate),
    [H.location]: item.villa.location,
    [H.overdue]: formatBoolean(item.overdue),
  };
}

function openWorkPdfRow(item: OpenWorkDto): ExportRow {
  return {
    villaNumber: item.villa.villaNumber,
    location: item.villa.location,
    elecPhase: item.elecPhase.name,
    status: WORK_STATUS_LABELS[item.status],
    priority: PRIORITY_LABELS[item.priority],
    // A whole number of percent, unlike a villa's average.
    progress: `${item.progress}%`,
    contractor: item.contractor?.name ?? "",
    startDate: asDate(item.startDate),
    endDate: asDate(item.endDate),
    overdue: formatBoolean(item.overdue),
  };
}

const DAILY_REPORT_PDF_COLUMNS = [
  column("reportDate", COLUMN_TITLES.reportDate, "date"),
  column("contractor", COLUMN_TITLES.contractor, "text"),
  column("electricalEngineer", COLUMN_TITLES.electricalEngineer, "text"),
  column("weather", COLUMN_TITLES.weather, "text"),
  column("workersCount", COLUMN_TITLES.workersCount, "integer"),
  column("notes", COLUMN_TITLES.notes, "text"),
];

const DAILY_REPORT_SHEET_COLUMNS = sheetColumns(DAILY_REPORT_IMPORT_COLUMNS, DAILY_REPORT_IGNORED_COLUMNS);

// The contractor and the engineer are written as the import reads them (see VillaReferences): the name, or the phone when another
// record of the kind has that name.
function dailyReportSheetRow(item: DailyReportDto, references: VillaReferences): ExportRow {
  return {
    [H.reportDate]: asDate(item.reportDate),
    [H.contractor]: references.party("contractor", item.contractor),
    [H.electricalEngineer]: references.party("electricalEngineer", item.preparedBy),
    [H.weather]: WEATHER_LABELS[item.weather],
    [H.workersCount]: item.workersCount,
    // The whole text, however long.
    [H.notes]: orNull(item.notes),
  };
}

function dailyReportPdfRow(item: DailyReportDto): ExportRow {
  return {
    reportDate: asDate(item.reportDate),
    contractor: item.contractor.name,
    electricalEngineer: item.preparedBy.name,
    weather: WEATHER_LABELS[item.weather],
    workersCount: item.workersCount,
    // The whole text, however long: the spreadsheet keeps all of it and the PDF wraps it to a few lines.
    notes: item.notes ?? "",
  };
}

const SMALL_WORK_PDF_COLUMNS = [
  column("villaNumber", COLUMN_TITLES.villaNumber, "text"),
  column("location", COLUMN_TITLES.location, "text"),
  column("startDate", COLUMN_TITLES.startDate, "date"),
  column("endDate", COLUMN_TITLES.endDate, "date"),
  column("description", COLUMN_TITLES.description, "text"),
  column("contractor", COLUMN_TITLES.contractor, "text"),
  column("status", COLUMN_TITLES.status, "text"),
];

const SMALL_WORK_SHEET_COLUMNS = sheetColumns(SMALL_WORK_IMPORT_COLUMNS, SMALL_WORK_IGNORED_COLUMNS);

// The contractor is written as the import reads it (see VillaReferences): its name, or its phone when another contractor has
// that name.
function smallWorkSheetRow(item: SmallWorkDto, references: VillaReferences): ExportRow {
  return {
    [H.villaNumber]: item.villa.villaNumber,
    [H.startDate]: asDate(item.startDate),
    [H.endDate]: asDate(item.endDate),
    [H.description]: item.description,
    [H.contractor]: references.party("contractor", item.contractor),
    [H.status]: SMALL_WORK_STATUS_LABELS[item.status],
    [H.location]: item.villa.location,
  };
}

function smallWorkPdfRow(item: SmallWorkDto): ExportRow {
  return {
    villaNumber: item.villa.villaNumber,
    location: item.villa.location,
    startDate: asDate(item.startDate),
    endDate: asDate(item.endDate),
    description: item.description,
    contractor: item.contractor.name,
    status: SMALL_WORK_STATUS_LABELS[item.status],
  };
}

const SITE_REPORT_PDF_COLUMNS = [
  column("villaNumber", COLUMN_TITLES.villaNumber, "text"),
  column("location", COLUMN_TITLES.location, "text"),
  column("visitDate", COLUMN_TITLES.visitDate, "date"),
  column("title", COLUMN_TITLES.title, "text"),
  column("type", COLUMN_TITLES.type, "text"),
  column("rating", COLUMN_TITLES.rating, "integer"),
  column("inspector", COLUMN_TITLES.inspector, "text"),
  column("findings", COLUMN_TITLES.findings, "text"),
  column("recommendations", COLUMN_TITLES.recommendations, "text"),
];

const SITE_REPORT_SHEET_COLUMNS = sheetColumns(SITE_REPORT_IMPORT_COLUMNS, SITE_REPORT_IGNORED_COLUMNS);

function siteReportSheetRow(item: SiteReportDto): ExportRow {
  return {
    [H.villaNumber]: item.villa.villaNumber,
    [H.title]: item.title,
    [H.visitDate]: asDate(item.visitDate),
    [H.inspector]: item.inspector,
    [H.type]: SITE_REPORT_TYPE_LABELS[item.type],
    [H.rating]: item.rating,
    // The whole text, however long.
    [H.findings]: item.findings,
    [H.recommendations]: orNull(item.recommendations),
    [H.location]: item.villa.location,
  };
}

function siteReportPdfRow(item: SiteReportDto): ExportRow {
  return {
    villaNumber: item.villa.villaNumber,
    location: item.villa.location,
    visitDate: asDate(item.visitDate),
    title: item.title,
    type: SITE_REPORT_TYPE_LABELS[item.type],
    rating: item.rating,
    inspector: item.inspector,
    // The whole text, however long: the spreadsheet keeps all of it and the PDF wraps it to a few lines.
    findings: item.findings,
    recommendations: item.recommendations ?? "",
  };
}

const DAILY_LABOUR_PDF_COLUMNS = [
  column("villaNumber", COLUMN_TITLES.villaNumber, "text"),
  column("location", COLUMN_TITLES.location, "text"),
  column("labourDate", COLUMN_TITLES.labourDate, "date"),
  column("contractor", COLUMN_TITLES.contractor, "text"),
  column("labourCount", COLUMN_TITLES.labourCount, "integer"),
  column("notes", COLUMN_TITLES.notes, "text"),
];

const DAILY_LABOUR_SHEET_COLUMNS = sheetColumns(DAILY_LABOUR_IMPORT_COLUMNS, DAILY_LABOUR_IGNORED_COLUMNS);

function dailyLabourSheetRow(item: DailyLabourDto): ExportRow {
  return {
    [H.villaNumber]: item.villa.villaNumber,
    [H.labourDate]: asDate(item.labourDate),
    [H.labourCount]: item.labourCount,
    [H.contractor]: item.contractor.name,
    [H.notes]: orNull(item.notes),
    [H.location]: item.villa.location,
  };
}

function dailyLabourPdfRow(item: DailyLabourDto): ExportRow {
  return {
    villaNumber: item.villa.villaNumber,
    location: item.villa.location,
    labourDate: asDate(item.labourDate),
    contractor: item.contractor.name,
    labourCount: item.labourCount,
    notes: item.notes ?? "",
  };
}

type SummaryVilla = {
  villaNumber: string;
  area: string;
  block: string;
  plot: string;
  startDate: string | null;
  targetDate: string | null;
};

const SUMMARY_COLUMNS = [
  VILLA_COLUMNS.villaNumber,
  VILLA_COLUMNS.area,
  VILLA_COLUMNS.block,
  VILLA_COLUMNS.plot,
  VILLA_COLUMNS.startDate,
  VILLA_COLUMNS.targetDate,
];

function summaryRow(item: SummaryVilla): ExportRow {
  return {
    villaNumber: item.villaNumber,
    area: item.area,
    block: item.block,
    plot: item.plot,
    startDate: asDate(item.startDate),
    targetDate: asDate(item.targetDate),
  };
}

const tooLarge = (ctx: RequestContext): AppError =>
  new AppError(422, t(ctx.locale, "errors.exportTooLarge"), "EXPORT_TOO_LARGE");

const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

type Writers = Record<ExportFormat, ExportWriter>;

export type ExportDependencies = {
  villas?: VillasService;
  contractors?: ContractorsService;
  civilEngineers?: CivilEngineersService;
  electricalEngineers?: ElectricalEngineersService;
  areas?: AreasService;
  auditLogs?: AuditService;
  openWorks?: OpenWorksService;
  dailyReports?: DailyReportsService;
  smallWorks?: SmallWorksService;
  siteReports?: SiteReportsService;
  dailyLabour?: DailyLabourService;
  writers?: Writers;
  now?: () => Date;
};

// Every export asks the module's own list service for its rows, with the filters the list endpoint was given,
// so an export and its list can never disagree about what matches. The first page doubles as the count: past
// the cap the request is refused before anything is generated.
export class ExportsService {
  private readonly villas: VillasService;
  private readonly contractors: ContractorsService;
  private readonly civilEngineers: CivilEngineersService;
  private readonly electricalEngineers: ElectricalEngineersService;
  private readonly areas: AreasService;
  private readonly auditLogs: AuditService;
  private readonly openWorks: OpenWorksService;
  private readonly dailyReports: DailyReportsService;
  private readonly smallWorks: SmallWorksService;
  private readonly siteReports: SiteReportsService;
  private readonly dailyLabour: DailyLabourService;
  private readonly writers: Writers;
  private readonly now: () => Date;

  constructor(dependencies: ExportDependencies = {}) {
    this.villas = dependencies.villas ?? new VillasService();
    this.contractors = dependencies.contractors ?? new ContractorsService();
    this.civilEngineers = dependencies.civilEngineers ?? new CivilEngineersService();
    this.electricalEngineers = dependencies.electricalEngineers ?? new ElectricalEngineersService();
    this.areas = dependencies.areas ?? new AreasService();
    this.auditLogs = dependencies.auditLogs ?? new AuditService();
    this.openWorks = dependencies.openWorks ?? new OpenWorksService();
    this.dailyReports = dependencies.dailyReports ?? new DailyReportsService();
    this.smallWorks = dependencies.smallWorks ?? new SmallWorksService();
    this.siteReports = dependencies.siteReports ?? new SiteReportsService();
    this.dailyLabour = dependencies.dailyLabour ?? new DailyLabourService();
    this.writers = dependencies.writers ?? { xlsx: writeXlsx, pdf: writePdf };
    this.now = dependencies.now ?? (() => new Date());
  }

  async villasExport({ format, query }: ParsedExport<ListVillasQuery>, actor: Actor, ctx: RequestContext) {
    const references = format === "xlsx" ? await this.villas.referenceBook() : undefined;
    return this.run(
      {
        names: EXPORT_NAMES.villas,
        action: "export.villas",
        entity: "Villa",
        columns: VILLAS_SHEET_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        pdf: { columns: VILLAS_PDF_COLUMNS, toRow: villaPdfRow },
        fetch: async (page) => {
          const { items, meta } = await this.villas.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: (item) => (references === undefined ? villaPdfRow(item) : villaSheetRow(item, references)),
      },
      format,
      actor,
      ctx,
    );
  }

  openWorksExport({ format, query }: ParsedExport<ListOpenWorksQuery>, actor: Actor, ctx: RequestContext) {
    return this.run(
      {
        names: EXPORT_NAMES.openWorks,
        action: "export.open-works",
        entity: "WorkItem",
        columns: OPEN_WORK_SHEET_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        pdf: { columns: OPEN_WORK_PDF_COLUMNS, toRow: openWorkPdfRow },
        fetch: async (page) => {
          const { items, meta } = await this.openWorks.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: openWorkSheetRow,
      },
      format,
      actor,
      ctx,
    );
  }

  async dailyReportsExport(
    { format, query }: ParsedExport<ListDailyReportsQuery>,
    actor: Actor,
    ctx: RequestContext,
  ) {
    const references = format === "xlsx" ? await this.villas.referenceBook() : undefined;
    return this.run(
      {
        names: EXPORT_NAMES.dailyReports,
        action: "export.daily-reports",
        entity: "DailyReport",
        columns: DAILY_REPORT_SHEET_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        pdf: { columns: DAILY_REPORT_PDF_COLUMNS, toRow: dailyReportPdfRow },
        fetch: async (page) => {
          const { items, meta } = await this.dailyReports.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: (item) =>
          references === undefined ? dailyReportPdfRow(item) : dailyReportSheetRow(item, references),
      },
      format,
      actor,
      ctx,
    );
  }

  async smallWorksExport(
    { format, query }: ParsedExport<ListSmallWorksQuery>,
    actor: Actor,
    ctx: RequestContext,
  ) {
    const references = format === "xlsx" ? await this.villas.referenceBook() : undefined;
    return this.run(
      {
        names: EXPORT_NAMES.smallWorks,
        action: "export.small-works",
        entity: "DailySmallWork",
        columns: SMALL_WORK_SHEET_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        pdf: { columns: SMALL_WORK_PDF_COLUMNS, toRow: smallWorkPdfRow },
        fetch: async (page) => {
          const { items, meta } = await this.smallWorks.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: (item) =>
          references === undefined ? smallWorkPdfRow(item) : smallWorkSheetRow(item, references),
      },
      format,
      actor,
      ctx,
    );
  }

  siteReportsExport(
    { format, query }: ParsedExport<ListSiteReportsQuery>,
    actor: Actor,
    ctx: RequestContext,
  ) {
    return this.run(
      {
        names: EXPORT_NAMES.siteReports,
        action: "export.site-reports",
        entity: "SiteReport",
        columns: SITE_REPORT_SHEET_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        pdf: { columns: SITE_REPORT_PDF_COLUMNS, toRow: siteReportPdfRow },
        fetch: async (page) => {
          const { items, meta } = await this.siteReports.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: siteReportSheetRow,
      },
      format,
      actor,
      ctx,
    );
  }

  dailyLabourExport(
    { format, query }: ParsedExport<ListDailyLabourQuery>,
    actor: Actor,
    ctx: RequestContext,
  ) {
    return this.run(
      {
        names: EXPORT_NAMES.dailyLabour,
        action: "export.daily-labour",
        entity: "DailyLabour",
        columns: DAILY_LABOUR_SHEET_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        pdf: { columns: DAILY_LABOUR_PDF_COLUMNS, toRow: dailyLabourPdfRow },
        fetch: async (page) => {
          const { items, meta } = await this.dailyLabour.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: dailyLabourSheetRow,
      },
      format,
      actor,
      ctx,
    );
  }

  contractorsExport(
    { format, query }: ParsedExport<ListContractorsQuery>,
    actor: Actor,
    ctx: RequestContext,
  ) {
    return this.run(
      {
        names: EXPORT_NAMES.contractors,
        action: "export.contractors",
        entity: "Contractor",
        columns: CONTRACTOR_SHEET_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        pdf: { columns: PEOPLE_COLUMNS, toRow: personRow },
        fetch: async (page) => {
          const { items, meta } = await this.contractors.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: contractorSheetRow,
      },
      format,
      actor,
      ctx,
    );
  }

  civilEngineersExport(
    { format, query }: ParsedExport<ListCivilEngineersQuery>,
    actor: Actor,
    ctx: RequestContext,
  ) {
    return this.run(
      {
        names: EXPORT_NAMES.civilEngineers,
        action: "export.civil-engineers",
        entity: "CivilEngineer",
        columns: PEOPLE_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        fetch: async (page) => {
          const { items, meta } = await this.civilEngineers.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: personRow,
      },
      format,
      actor,
      ctx,
    );
  }

  electricalEngineersExport(
    { format, query }: ParsedExport<ListElectricalEngineersQuery>,
    actor: Actor,
    ctx: RequestContext,
  ) {
    return this.run(
      {
        names: EXPORT_NAMES.electricalEngineers,
        action: "export.electrical-engineers",
        entity: "ElectricalEngineer",
        columns: PEOPLE_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        fetch: async (page) => {
          const { items, meta } = await this.electricalEngineers.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: personRow,
      },
      format,
      actor,
      ctx,
    );
  }

  areasExport({ format, query }: ParsedExport<ListAreasQuery>, actor: Actor, ctx: RequestContext) {
    return this.run(
      {
        names: EXPORT_NAMES.areas,
        action: "export.areas",
        entity: "Area",
        columns: AREA_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        fetch: async (page) => {
          const { items, meta } = await this.areas.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: areaRow,
      },
      format,
      actor,
      ctx,
    );
  }

  // The villa count comes from the summary itself and is also the row count.
  contractorSummaryExport(
    contractorId: string,
    { format, query }: ParsedExport<ContractorSummaryQuery>,
    actor: Actor,
    ctx: RequestContext,
  ) {
    type Summary = Awaited<ReturnType<ContractorsService["summary"]>>["summary"];
    return this.run<SummaryVilla, Summary>(
      {
        names: EXPORT_NAMES.contractorSummary,
        action: "export.contractor-summary",
        entity: "Contractor",
        entityId: contractorId,
        columns: SUMMARY_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        fetch: async (page) => {
          const { summary, meta } = await this.contractors.summary(contractorId, { ...query, page }, ctx);
          return { items: summary.villas, total: meta.total, extra: summary };
        },
        toRow: summaryRow,
        summary: ({ extra }) => {
          const { contractor, villaCount } = extra;
          return [
            [SUMMARY_LABELS.contractor, contractor.name],
            [SUMMARY_LABELS.phone, contractor.phone],
            [SUMMARY_LABELS.total, String(villaCount)],
          ];
        },
      },
      format,
      actor,
      ctx,
    );
  }

  auditLogsExport({ format, query }: ParsedExport<ListAuditLogsQuery>, actor: Actor, ctx: RequestContext) {
    return this.run(
      {
        names: EXPORT_NAMES.auditLogs,
        action: "export.audit-logs",
        entity: "AuditLog",
        columns: AUDIT_COLUMNS,
        filters: describeFilters(query),
        applied: appliedFilters(query),
        fetch: async (page) => {
          const { items, meta } = await this.auditLogs.list({ ...query, page });
          return { items, total: meta.total, extra: undefined };
        },
        toRow: auditRow,
      },
      format,
      actor,
      ctx,
    );
  }

  private async run<Item, Extra = undefined>(
    definition: Definition<Item, Extra>,
    format: ExportFormat,
    actor: Actor,
    ctx: RequestContext,
  ): Promise<ExportResult> {
    const first = await definition.fetch(1);
    if (first.total > EXPORT_MAX_ROWS) {
      throw tooLarge(ctx);
    }

    // Written before the file is, so an export always leaves a trace, whatever happens to the download.
    // It holds the filters, the format and the count, never the rows.
    await prisma.$transaction((tx) =>
      audit.record(
        tx,
        withMeta(ctx, {
          actorId: actor.id,
          action: definition.action,
          entity: definition.entity,
          ...(definition.entityId !== undefined && { entityId: definition.entityId }),
          after: { format, filters: definition.applied, rowCount: first.total },
        }),
      ),
    );

    const generatedAt = this.now();
    const view = format === "pdf" && definition.pdf !== undefined ? definition.pdf : definition;
    const document: ExportDocument = {
      title: definition.names.title,
      sheetName: definition.names.sheet,
      generatedAt,
      filters: definition.filters,
      columns: view.columns,
      rows: this.chunks(definition, view.toRow, first),
      ...(definition.summary && { summary: definition.summary(first) }),
    };
    const writer = this.writers[format];
    return {
      filename: `asico-${definition.names.file}-${formatDate(generatedAt)}.${format}`,
      contentType: CONTENT_TYPES[format],
      write: (out) => writer(document, out),
    };
  }

  // The rows, one page at a time. The loop lets the server handle other requests between pages.
  private async *chunks<Item, Extra>(
    definition: Definition<Item, Extra>,
    toRow: (item: Item) => ExportRow,
    first: Page<Item, Extra>,
  ): AsyncGenerator<ExportRow[]> {
    yield first.items.map(toRow);
    const pages = Math.ceil(first.total / MAX_LIMIT);
    for (let page = 2; page <= pages; page++) {
      await nextTick();
      const next = await definition.fetch(page);
      if (next.items.length === 0) {
        return;
      }
      yield next.items.map(toRow);
    }
  }
}
