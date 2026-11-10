import { deflateRawSync, inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";

// A one-sheet workbook. Each row is a list of cell values; null leaves the cell empty. A value may be an ExcelJS
// formula ({ formula, result }) or rich text.
export async function workbookOf(
  rows: readonly (readonly (ExcelJS.CellValue | undefined)[])[],
  options: { sheetName?: string; otherSheets?: Record<string, (readonly ExcelJS.CellValue[])[]> } = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheetName ?? "Data");
  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value !== null && value !== undefined) {
        sheet.getCell(r + 1, c + 1).value = value;
      }
    });
  });
  for (const [name, otherRows] of Object.entries(options.otherSheets ?? {})) {
    const other = workbook.addWorksheet(name);
    otherRows.forEach((row, r) => row.forEach((value, c) => (other.getCell(r + 1, c + 1).value = value)));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export type ZipEntry = {
  name: string;
  // The bytes before compression.
  data: Buffer;
  // What the archive says the entry unpacks to, when that should differ from the truth.
  declaredSize?: number;
  // Store the bytes as they are instead of deflating them.
  stored?: boolean;
  // General purpose flags, for example 1 for "encrypted".
  flags?: number;
};

// A ZIP built by hand, so a test can make one that lies about itself.
export function zipOf(entries: readonly ZipEntry[], options: { zip64?: boolean } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.stored ? entry.data : deflateRawSync(entry.data);
    const size = entry.declaredSize ?? entry.data.length;
    const flags = entry.flags ?? 0;
    const method = entry.stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// The same workbook with columns added at the end of its first sheet: each header goes in row 1 and its value in every
// other row. It makes the file an export would write out of a file written for the import.
export async function withColumns(
  bytes: Buffer,
  columns: Readonly<Record<string, ExcelJS.CellValue>>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0]!;
  let at = sheet.getRow(1).cellCount;
  for (const [header, value] of Object.entries(columns)) {
    at += 1;
    sheet.getCell(1, at).value = header;
    for (let r = 2; r <= sheet.rowCount; r++) {
      sheet.getCell(r, at).value = value;
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// The text of one file inside a workbook (xl/worksheets/sheet1.xml, say), read from the archive's central directory: for a test
// that needs the XML a workbook was written with, not what a reader makes of it.
export function xmlOf(workbook: Buffer, name: string): string {
  const end = workbook.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = workbook.readUInt32LE(end + 16);
  for (let entries = workbook.readUInt16LE(end + 10); entries > 0; entries--) {
    const method = workbook.readUInt16LE(at + 10);
    const size = workbook.readUInt32LE(at + 20);
    const nameLength = workbook.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + workbook.readUInt16LE(at + 30) + workbook.readUInt16LE(at + 32);
    if (workbook.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      const local = workbook.readUInt32LE(at + 42);
      const start = local + 30 + workbook.readUInt16LE(local + 26) + workbook.readUInt16LE(local + 28);
      const stored = workbook.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(stored) : stored).toString("utf8");
    }
    at = next;
  }
  throw new Error(`No ${name} in the workbook`);
}
