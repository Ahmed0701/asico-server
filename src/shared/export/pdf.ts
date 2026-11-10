import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import PDFDocument from "pdfkit";
import { isRtlParagraph, visualRuns, type VisualRun } from "./bidi.js";
import { formatCell, formatDateTime } from "./format.js";
import { REPORT } from "./labels.js";
import { planColumns, wrapLines, type ColumnMeasure, type Measure } from "./layout.js";
import { isNumericKind, type ExportColumn, type ExportDocument, type ExportWriter } from "./types.js";

// Tajawal (SIL Open Font License) covers Arabic and Latin in one family, so a name in either script, or both
// in one cell, is drawn from the same font.
const FONT_DIR = fileURLToPath(new URL("../../assets/fonts/", import.meta.url));
const REGULAR = "regular";
const BOLD = "bold";

const MARGIN = 36;
const FOOTER_SPACE = 22;
const CELL_PADDING = 4;
const ELLIPSIS = "\u2026";

const INK = "#111827";
const MUTED = "#6B7280";
const HEADER_FILL = "#1F3A5F";
const STRIPE_FILL = "#EEF2F7";
const RULE = "#C7D0DB";

// An Arabic run is drawn with its letters joined and in reading order.
const RTL_FEATURES = { features: ["rtla"] } as never;

type Doc = InstanceType<typeof PDFDocument>;

function runWidth(doc: Doc, run: VisualRun): number {
  return run.rtl ? doc.widthOfString(run.text, RTL_FEATURES) : doc.widthOfString(run.text);
}

function runsWidth(doc: Doc, runs: VisualRun[]): number {
  return runs.reduce((sum, run) => sum + runWidth(doc, run), 0);
}

// The text cut, if it has to be, so that it and an ellipsis fit in `maxWidth`.
function fit(doc: Doc, text: string, maxWidth: number): VisualRun[] {
  const whole = visualRuns(text);
  if (runsWidth(doc, whole) <= maxWidth) {
    return whole;
  }
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = visualRuns(`${characters.slice(0, middle).join("").trimEnd()}${ELLIPSIS}`);
    if (runsWidth(doc, candidate) <= maxWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return visualRuns(`${characters.slice(0, low).join("").trimEnd()}${ELLIPSIS}`);
}

type Align = "left" | "right";

function drawText(doc: Doc, text: string, x: number, y: number, width: number, align: Align): void {
  drawRuns(doc, fit(doc, text, width), x, y, width, align);
}

// `widthOf` says how wide a run is. Cells pass the measurer that already holds the width of every word in the
// table; shaping the same text again for its width is what makes a large table slow.
function drawRuns(
  doc: Doc,
  runs: VisualRun[],
  x: number,
  y: number,
  width: number,
  align: Align,
  widthOf: (run: VisualRun) => number = (run) => runWidth(doc, run),
): void {
  let cursor = x;
  if (align === "right") {
    cursor = x + width - runs.reduce((sum, run) => sum + widthOf(run), 0);
  }
  for (const run of runs) {
    const runWidth = widthOf(run);
    // textWidth saves the library from measuring the run again.
    doc.text(run.text, cursor, y, {
      lineBreak: false,
      textWidth: runWidth,
      ...(run.rtl ? (RTL_FEATURES as object) : {}),
    } as never);
    cursor += runWidth;
  }
}

// Filters are packed into as many lines as they need, at most three.
function packLines(doc: Doc, items: string[], maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current === "" ? item : `${current}   |   ${item}`;
    if (current !== "" && runsWidth(doc, visualRuns(next)) > maxWidth) {
      lines.push(current);
      current = item;
    } else {
      current = next;
    }
  }
  if (current !== "") {
    lines.push(current);
  }
  return lines.slice(0, 3);
}

// Vertical space: a line is the font size plus LINE_GAP high; a body row adds ROW_PADDING, a header row
// HEADER_PADDING, above and below together.
const LINE_GAP = 2;
const ROW_PADDING = 7;
const HEADER_PADDING = 10;
const HEADER_MAX_LINES = 3;
// Text is measured once at this size and scaled, so one measurement serves every font size tried.
const UNIT_SIZE = 10;

// How wide the text is at a font size of 1 point, in the given font. Shaping text is the slow part of laying a
// table out, so it is done a word at a time (a word repeats across rows: a status, an area, a name) and a line
// is the sum of its words and the spaces between them.
function unitMeasurer(doc: Doc, font: string): (text: string) => number {
  const words = new Map<string, number>();
  const word = (text: string): number => {
    const known = words.get(text);
    if (known !== undefined) {
      return known;
    }
    doc.font(font).fontSize(UNIT_SIZE);
    const unit = runsWidth(doc, visualRuns(text)) / UNIT_SIZE;
    words.set(text, unit);
    return unit;
  };
  return (text) => {
    const parts = text.split(" ");
    let total = (parts.length - 1) * word(" ");
    for (const part of parts) {
      if (part !== "") {
        total += word(part);
      }
    }
    return total;
  };
}

type Table = {
  doc: Doc;
  columns: ExportColumn[];
  xs: number[];
  widths: number[];
  tableWidth: number;
  fontSize: number;
  lineHeight: number;
  body: Measure;
  header: Measure;
  headerLines: string[][];
  headerHeight: number;
  bottom: number;
};

const textWidth = (table: Table, index: number): number => (table.widths[index] ?? 0) - 2 * CELL_PADDING;

function drawHeader(table: Table, y: number): number {
  const { doc, columns, xs, tableWidth, fontSize, lineHeight, headerHeight } = table;
  doc.rect(MARGIN, y, tableWidth, headerHeight).fill(HEADER_FILL);
  doc.font(BOLD).fontSize(fontSize).fillColor("#FFFFFF");
  columns.forEach((column, index) => {
    const align: Align = isNumericKind(column.kind) ? "right" : "left";
    (table.headerLines[index] ?? []).forEach((line, number) => {
      drawRuns(
        doc,
        visualRuns(line),
        (xs[index] ?? 0) + CELL_PADDING,
        y + HEADER_PADDING / 2 + 0.5 + number * lineHeight,
        textWidth(table, index),
        align,
        (run) => table.header(run.text),
      );
    });
  });
  doc.font(REGULAR).fillColor(INK);
  return y + headerHeight;
}

type PreparedRow = { cells: { lines: string[]; align: Align; rtl: boolean }[]; height: number };

// The lines of every cell at the column's width, and the height of the tallest. A row is laid out before it is
// drawn so that it can be kept whole on one page.
function prepareRow(table: Table, values: string[]): PreparedRow {
  const cells = table.columns.map((column, index) => {
    const value = values[index] ?? "";
    const rtl = isRtlParagraph(value);
    return {
      lines: wrapLines(value, textWidth(table, index), table.body),
      align: (isNumericKind(column.kind) || rtl ? "right" : "left") as Align,
      rtl,
    };
  });
  const lines = Math.max(1, ...cells.map((cell) => cell.lines.length));
  return { cells, height: ROW_PADDING + lines * table.lineHeight };
}

function drawRow(table: Table, y: number, row: PreparedRow, striped: boolean): void {
  const { doc, xs, tableWidth, fontSize, lineHeight } = table;
  if (striped) {
    doc.rect(MARGIN, y, tableWidth, row.height).fill(STRIPE_FILL);
    doc.fillColor(INK);
  }
  doc.font(REGULAR).fontSize(fontSize).fillColor(INK);
  row.cells.forEach((cell, index) => {
    cell.lines.forEach((line, number) => {
      drawRuns(
        doc,
        visualRuns(line, cell.rtl ? "rtl" : "ltr"),
        (xs[index] ?? 0) + CELL_PADDING,
        y + ROW_PADDING / 2 + 0.5 + number * lineHeight,
        textWidth(table, index),
        cell.align,
        (run) => table.body(run.text),
      );
    });
  });
  doc
    .moveTo(MARGIN, y + row.height)
    .lineTo(MARGIN + tableWidth, y + row.height)
    .lineWidth(0.3)
    .strokeColor(RULE)
    .stroke();
}
const nextTick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A4 landscape. The rows are drawn as they arrive; pages are kept until the end (the footer needs the page
// total), which is a few megabytes at the largest export.
export const writePdf: ExportWriter = async (document: ExportDocument, out: Writable) => {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: MARGIN, bottom: MARGIN + FOOTER_SPACE, left: MARGIN, right: MARGIN },
    bufferPages: true,
    autoFirstPage: false,
    info: {
      Title: `${REPORT.brand} - ${document.title}`,
      Author: REPORT.brand,
      Creator: REPORT.brand,
      CreationDate: document.generatedAt,
    },
  });
  doc.registerFont(REGULAR, `${FONT_DIR}Tajawal-Regular.ttf`);
  doc.registerFont(BOLD, `${FONT_DIR}Tajawal-Bold.ttf`);

  const finished = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
    out.on("error", reject);
  });
  doc.pipe(out);

  doc.addPage();
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const tableWidth = pageWidth - 2 * MARGIN;
  const bottom = pageHeight - MARGIN - FOOTER_SPACE;

  // The column widths come from the content, so every row is read before the first one is drawn. An export is
  // capped at EXPORT_MAX_ROWS, which keeps this to a few megabytes of text.
  const data: string[][] = [];
  for await (const chunk of document.rows) {
    for (const source of chunk) {
      data.push(document.columns.map((column) => formatCell(source[column.key] ?? null, column.kind)));
    }
    await nextTick();
  }

  const regularUnit = unitMeasurer(doc, REGULAR);
  const boldUnit = unitMeasurer(doc, BOLD);
  // A title can wrap onto its own lines, so what a header column needs is room for its longest word.
  const measures: ColumnMeasure[] = document.columns.map((column, index) => ({
    kind: column.kind,
    headerUnit: Math.max(0, ...column.title.split(/\s+/).map(boldUnit)),
    widestUnit: data.reduce((widest, values) => Math.max(widest, regularUnit(values[index] ?? "")), 0),
  }));
  const plan = planColumns(measures, tableWidth, CELL_PADDING);
  const fontSize = plan.fontSize;
  const widths = plan.widths;
  const xs = widths.map((_, index) => MARGIN + widths.slice(0, index).reduce((sum, width) => sum + width, 0));
  const lineHeight = fontSize + LINE_GAP;
  const headerLines = document.columns.map((column, index) =>
    wrapLines(
      column.title,
      (widths[index] ?? 0) - 2 * CELL_PADDING,
      (text) => boldUnit(text) * fontSize,
      HEADER_MAX_LINES,
    ),
  );
  const table: Table = {
    doc,
    columns: document.columns,
    xs,
    widths,
    tableWidth,
    fontSize,
    lineHeight,
    body: (text) => regularUnit(text) * fontSize,
    header: (text) => boldUnit(text) * fontSize,
    headerLines,
    headerHeight: HEADER_PADDING + Math.max(1, ...headerLines.map((lines) => lines.length)) * lineHeight,
    bottom,
  };

  // Title block.
  let y = MARGIN;
  doc.font(BOLD).fontSize(16).fillColor(INK);
  drawText(doc, document.title, MARGIN, y, tableWidth * 0.7, "left");
  doc.font(BOLD).fontSize(10).fillColor(HEADER_FILL);
  drawText(doc, REPORT.brand, MARGIN + tableWidth * 0.7, y + 4, tableWidth * 0.3, "right");
  y += 26;
  doc.font(REGULAR).fontSize(8).fillColor(MUTED);
  drawText(
    doc,
    `${REPORT.generated}: ${formatDateTime(document.generatedAt)}`,
    MARGIN,
    y,
    tableWidth,
    "left",
  );
  y += 13;

  doc.font(REGULAR).fontSize(8).fillColor(INK);
  const filterLines =
    document.filters.length === 0 ? [REPORT.noFilters] : packLines(doc, document.filters, tableWidth - 44);
  filterLines.forEach((line, index) => {
    doc.font(BOLD);
    if (index === 0) {
      drawText(doc, `${REPORT.filters}:`, MARGIN, y, 44, "left");
    }
    doc.font(REGULAR);
    drawText(doc, line, MARGIN + 44, y, tableWidth - 44, "left");
    y += 11;
  });

  if (document.summary && document.summary.length > 0) {
    y += 4;
    for (const [label, value] of document.summary) {
      doc.font(BOLD).fontSize(9);
      drawText(doc, `${label}:`, MARGIN, y, 110, "left");
      doc.font(REGULAR);
      drawText(doc, value, MARGIN + 114, y, tableWidth - 114, "left");
      y += 13;
    }
  }
  y += 8;

  y = drawHeader(table, y);

  let rows = 0;
  for (const values of data) {
    const row = prepareRow(table, values);
    // A row is never split: if it does not fit in what is left of the page it starts the next one.
    if (y + row.height > table.bottom) {
      doc.addPage();
      y = drawHeader(table, MARGIN);
    }
    drawRow(table, y, row, rows % 2 === 1);
    y += row.height;
    rows += 1;
    if (rows % 500 === 0) {
      await nextTick();
    }
  }

  if (rows === 0) {
    doc.font(REGULAR).fontSize(10).fillColor(MUTED);
    drawText(doc, REPORT.noRecords, MARGIN, y + 14, tableWidth, "left");
  }

  // Page X of Y, now that the total is known. The footer sits inside the bottom margin, so that margin is
  // lifted while it is drawn (text below it would otherwise start a new page).
  const range = doc.bufferedPageRange();
  for (let index = 0; index < range.count; index++) {
    doc.switchToPage(range.start + index);
    doc.page.margins.bottom = 0;
    doc.font(REGULAR).fontSize(8).fillColor(MUTED);
    drawText(doc, REPORT.page(index + 1, range.count), MARGIN, pageHeight - MARGIN - 4, tableWidth, "right");
    drawText(
      doc,
      `${REPORT.brand} - ${document.title}`,
      MARGIN,
      pageHeight - MARGIN - 4,
      tableWidth * 0.6,
      "left",
    );
  }

  doc.end();
  await finished;
  return { rows };
};
