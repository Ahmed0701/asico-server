import { inflateSync } from "node:zlib";
import { PassThrough } from "node:stream";
import type {
  CellValue,
  ExportColumn,
  ExportDocument,
  ExportRow,
  ExportWriter,
} from "../../../src/shared/export/types.js";

// Collects what a generator writes.
export async function render(
  writer: ExportWriter,
  document: ExportDocument,
): Promise<{ bytes: Buffer; rows: number }> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => {
    out.on("end", resolve);
    out.on("error", reject);
  });
  const { rows } = await writer(document, out);
  out.end();
  await finished;
  return { bytes: Buffer.concat(chunks), rows };
}

export async function* inChunks(rows: ExportRow[], size = 2): AsyncGenerator<ExportRow[]> {
  for (let i = 0; i < rows.length; i += size) {
    yield rows.slice(i, i + size);
  }
}

export const col = (key: string, title: string, kind: ExportColumn["kind"] = "text"): ExportColumn => ({
  key,
  title,
  kind,
});

export function document(
  columns: ExportColumn[],
  rows: Record<string, CellValue>[],
  extra: Partial<ExportDocument> = {},
): ExportDocument {
  return {
    title: "Test Report",
    sheetName: "Test",
    generatedAt: new Date("2026-10-12T13:55:00.000Z"),
    filters: [],
    columns,
    rows: inChunks(rows),
    ...extra,
  };
}

// A PDF read back: its page count and the text of each page, as the viewer would extract it.
export async function readPdf(bytes: Buffer): Promise<{ numPages: number; pages: string[][] }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages: string[][] = [];
  for (let number = 1; number <= loaded.numPages; number++) {
    const page = await loaded.getPage(number);
    const content = await page.getTextContent();
    pages.push(
      content.items.map((item) => ("str" in item ? item.str : "")).filter((text) => text.trim() !== ""),
    );
  }
  return { numPages: loaded.numPages, pages };
}

export type PlacedText = { text: string; x: number; y: number };

// Every piece of text on every page with its position (y counted up from the bottom of the page).
export async function readPlacedText(bytes: Buffer): Promise<PlacedText[][]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loaded = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const pages: PlacedText[][] = [];
  for (let number = 1; number <= loaded.numPages; number++) {
    const content = await (await loaded.getPage(number)).getTextContent();
    pages.push(
      content.items.flatMap((item) =>
        "str" in item && item.str.trim() !== ""
          ? [{ text: item.str, x: item.transform[4] as number, y: item.transform[5] as number }]
          : [],
      ),
    );
  }
  return pages;
}

// The drawing instructions of every page, decompressed, so colours and shapes can be checked.
export function pageContent(bytes: Buffer): string {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const start = bytes.indexOf("stream\n", from, "latin1");
    if (start === -1) break;
    const end = bytes.indexOf("\nendstream", start, "latin1");
    if (end === -1) break;
    try {
      parts.push(inflateSync(bytes.subarray(start + "stream\n".length, end)).toString("latin1"));
    } catch {
      // not a compressed stream (a font, say)
    }
    // Past the closing keyword, which itself contains the word "stream".
    from = end + 10;
  }
  return parts.join("\n");
}
