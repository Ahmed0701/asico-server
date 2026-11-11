import ExcelJS from "exceljs";
import { fitSheetColumns } from "../export/xlsx.js";
import {
  IMPORT_MAX_BYTES,
  IMPORT_MAX_CELL_CHARS,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_LIST_VALUES,
  IMPORT_MAX_ROWS,
} from "./limits.js";
import type { ImportColumn } from "./types.js";

// Templates are always in English, like every generated file.
export type TemplateSpec = {
  // The name of the sheet the records go in, and what the instructions call the records.
  sheetName: string;
  plural: string;
  columns: readonly ImportColumn[];
  // The choices of a dropdown, by the header of the column. They replace the column's own `values`, and are not listed in the
  // instructions (a list of villas or contractors can be long). A header that is not a column is a mistake.
  lists?: Readonly<Record<string, readonly string[]>>;
};

const HEADER_FILL = "FF1F3A5F";
const HEADER_FONT = "FFFFFFFF";
const EXAMPLE_FONT = "FF7F7F7F";
const INSTRUCTIONS_SHEET = "Instructions";
const LISTS_SHEET = "Lists";
const TEXT_FORMAT = "@";
// What a spreadsheet keeps of a validation's texts: a title up to 32 characters, a message up to 255 (UTF-16 units).
const MAX_TITLE_CHARS = 32;
const MAX_MESSAGE_CHARS = 255;
const SHOWN_CHOICES = 10;
const SECTION_TITLES = ["Limits", "Columns"];

const megabytes = IMPORT_MAX_BYTES / (1024 * 1024);
const grouped = (n: number): string => n.toLocaleString("en-US");

// The text cut to `max` UTF-16 units, at a whole character, ending in "..." when it was cut.
function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let kept = "";
  for (const character of text) {
    if (kept.length + character.length > max - 3) {
      break;
    }
    kept += character;
  }
  return `${kept}...`;
}

function instructionLines(spec: TemplateSpec): string[] {
  // A column that allows more says so in its own description; the line here names the rule for the others.
  const longer = spec.columns.some((column) => (column.maxChars ?? 0) > IMPORT_MAX_CELL_CHARS);
  return [
    `Import ${spec.plural}`,
    "",
    `1. Fill in the "${spec.sheetName}" sheet, one record per row, starting at row 2.`,
    "2. Row 2 holds an example. Replace it or delete it: it is imported like any other row.",
    "3. Keep the header row as it is. Do not rename, repeat or add columns. The order of the columns can change.",
    "4. Save the file as .xlsx and upload it. Use a dry run first to check the file without saving anything.",
    "",
    "Limits",
    `- Only the first sheet is read. Up to ${grouped(IMPORT_MAX_ROWS)} rows and ${IMPORT_MAX_COLUMNS} columns.`,
    `- A cell holds up to ${grouped(IMPORT_MAX_CELL_CHARS)} characters${longer ? " (a long-text column says how many more)" : ""}. The file is up to ${megabytes} MB.`,
    "- Cells are read as values. A formula is never calculated: paste its value instead.",
    "- If any row has a problem, nothing is imported. The same file cannot be imported twice.",
    "",
    "Columns",
  ];
}

type Choices = {
  // Everything the column offers, and the part of it the dropdown lists (the first IMPORT_MAX_LIST_VALUES).
  all: readonly string[];
  shown: readonly string[];
  cut: boolean;
};

function choicesOf(spec: TemplateSpec): Choices[] {
  const headers = new Set(spec.columns.map((column) => column.header));
  for (const header of Object.keys(spec.lists ?? {})) {
    if (!headers.has(header)) {
      throw new Error(`The ${spec.sheetName} template has no column "${header}" for a list`);
    }
  }
  return spec.columns.map((column) => {
    const all = spec.lists?.[column.header] ?? column.values ?? [];
    const cut = all.length > IMPORT_MAX_LIST_VALUES;
    return { all, shown: cut ? all.slice(0, IMPORT_MAX_LIST_VALUES) : all, cut };
  });
}

// The workbook people fill in: the header row, one example row, a dropdown on every column that has a list of choices (a
// fixed list of values, or the records it points to), and an Instructions sheet. The data sheet comes first because only the
// first sheet is read; the hidden Lists sheet holds the choices and comes last.
export async function buildTemplate(spec: TemplateSpec): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Elecico";
  const choices = choicesOf(spec);
  const data = workbook.addWorksheet(spec.sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
  // ExcelJS has no typed access to a sheet's validations. A rule given for a range is written as it is; one given cell by cell
  // is merged by ExcelJS, which sorts the addresses as text ("D10" before "D2") and so writes two overlapping rules.
  const validations = (
    data as unknown as { dataValidations: { add(range: string, rule: ExcelJS.DataValidation): void } }
  ).dataValidations;
  const instructions = workbook.addWorksheet(INSTRUCTIONS_SHEET);
  const lists = workbook.addWorksheet(LISTS_SHEET, { state: "hidden" });

  // Every column is text, so a phone number keeps its leading zero.
  data.columns = spec.columns.map((column) => ({
    header: column.header,
    key: column.header,
    style: { numFmt: TEXT_FORMAT },
  }));
  const header = data.getRow(1);
  header.height = 20;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_FONT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
  });

  const example = data.getRow(2);
  spec.columns.forEach((column, index) => {
    const cell = example.getCell(index + 1);
    cell.value = column.example;
    cell.font = { italic: true, color: { argb: EXAMPLE_FONT } };
  });

  // The choices of each dropdown go in the hidden sheet, one list per column, and the data sheet points at them. One rule per
  // column covers every row the importer reads.
  choices.forEach(({ shown, cut, all }, index) => {
    if (shown.length === 0) {
      return;
    }
    const column = spec.columns[index]!;
    const letter = data.getColumn(index + 1).letter;
    shown.forEach((value, at) => {
      lists.getCell(at + 1, index + 1).value = value;
    });
    const offered = all.slice(0, SHOWN_CHOICES).join(", ") + (all.length > SHOWN_CHOICES ? ", ..." : "");
    validations.add(`${letter}2:${letter}${IMPORT_MAX_ROWS + 1}`, {
      type: "list",
      allowBlank: !column.required,
      formulae: [`${LISTS_SHEET}!$${letter}$1:$${letter}$${shown.length}`],
      showInputMessage: true,
      promptTitle: clip(column.header, MAX_TITLE_CHARS),
      prompt: column.required ? "Pick one from the list." : "Pick one from the list, or leave it empty.",
      showErrorMessage: true,
      errorStyle: cut ? "warning" : "stop",
      errorTitle: clip(column.header, MAX_TITLE_CHARS),
      error: clip(
        cut
          ? `The list shows only the first ${grouped(IMPORT_MAX_LIST_VALUES)} choices. Keep this value only if it is correct.`
          : `Choose one of: ${offered}`,
        MAX_MESSAGE_CHARS,
      ),
    });
  });

  const lines = instructionLines(spec);
  lines.forEach((line, index) => {
    const cell = instructions.getCell(index + 1, 1);
    cell.value = line;
    cell.font = { bold: index === 0 || SECTION_TITLES.includes(line) };
  });
  ["Column", "Required", "What to enter", "Example"].forEach((title, index) => {
    const cell = instructions.getCell(lines.length + 1, index + 1);
    cell.value = title;
    cell.font = { bold: true };
  });
  spec.columns.forEach((column, index) => {
    const row = instructions.getRow(lines.length + 2 + index);
    const values = column.values ?? [];
    row.getCell(1).value = column.header;
    row.getCell(2).value = column.required ? "Yes" : "No";
    const cut = choices[index]?.cut ?? false;
    row.getCell(3).value =
      (values.length > 0 ? `${column.description} One of: ${values.join(", ")}.` : column.description) +
      (cut
        ? ` The dropdown shows the first ${grouped(IMPORT_MAX_LIST_VALUES)} choices; any other value can be typed.`
        : "");
    row.getCell(3).alignment = { wrapText: true, vertical: "top" };
    row.getCell(4).value = column.example;
  });

  // Every sheet is fitted the way an export is. The data sheet also allows for the longest choice of a dropdown.
  fitSheetColumns(data, new Map(choices.map(({ shown }, index) => [index, shown] as const)));
  fitSheetColumns(instructions);
  fitSheetColumns(lists);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
