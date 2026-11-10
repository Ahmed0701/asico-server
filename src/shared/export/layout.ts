import type { ColumnKind } from "./types.js";

// Layout decisions for the generated files, kept free of any PDF or spreadsheet library so they can be tested
// on their own. A "measure" is whatever returns the width of one line of text; the PDF supplies the embedded
// font's real metrics, the tests a fixed width per character.

export type Measure = (text: string) => number;

const ELLIPSIS = String.fromCharCode(0x2026);

// A cell is never taller than this many lines. Past it the last line ends in an ellipsis: the last resort
// for a value that would otherwise take a page.
export const MAX_CELL_LINES = 6;

const BREAKS_AFTER = new Set(["-", "/", "_", ".", ":"]);
const isSpace = (char: string): boolean => /\s/.test(char);

// Pieces of text a line may end after: words (with the space after them), and the parts of a hyphenated, dotted or slashed
// word, so a long id breaks at its hyphens and not in the middle of a group.
function pieces(text: string): string[] {
  const characters = Array.from(text);
  const result: string[] = [];
  let current = "";
  characters.forEach((char, index) => {
    current += char;
    const next = characters[index + 1];
    const ends = isSpace(char)
      ? next !== undefined && !isSpace(next)
      : BREAKS_AFTER.has(char) && next !== undefined && !isSpace(next);
    if (ends) {
      result.push(current);
      current = "";
    }
  });
  if (current !== "") {
    result.push(current);
  }
  return result;
}

// The longest start of `text` (in whole characters, at least one) that fits.
function longestFit(text: string, maxWidth: number, measure: Measure): number {
  const characters = Array.from(text);
  let low = 1;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(characters.slice(0, middle).join("").trimEnd()) <= maxWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

// `text` cut so that it and an ellipsis fit.
export function truncate(text: string, maxWidth: number, measure: Measure): string {
  if (measure(text) <= maxWidth) {
    return text;
  }
  const characters = Array.from(text);
  let low = 0;
  let high = characters.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measure(`${characters.slice(0, middle).join("").trimEnd()}${ELLIPSIS}`) <= maxWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, low).join("").trimEnd()}${ELLIPSIS}`;
}

// Breaks text into lines no wider than `maxWidth`, at spaces and after hyphens, slashes, underscores, dots and colons; a single
// word wider than the column is broken between characters. Each line is returned in reading order, ready to be
// laid out on its own (so Arabic and mixed text are reordered per line, not per cell). Only a value that needs
// more than `maxLines` lines is cut, with an ellipsis on the last line.
export function wrapLines(
  text: string,
  maxWidth: number,
  measure: Measure,
  maxLines = MAX_CELL_LINES,
): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return [""];
  }
  if (measure(normalized) <= maxWidth) {
    return [normalized];
  }

  const lines: string[] = [];
  let line = "";
  for (const piece of pieces(normalized)) {
    if (measure((line + piece).trimEnd()) <= maxWidth) {
      line += piece;
      continue;
    }
    if (line !== "") {
      lines.push(line.trimEnd());
    }
    let rest = piece;
    while (measure(rest.trimEnd()) > maxWidth) {
      const cut = longestFit(rest, maxWidth, measure);
      lines.push(Array.from(rest).slice(0, cut).join("").trimEnd());
      rest = Array.from(rest).slice(cut).join("");
    }
    line = rest;
  }
  if (line.trim() !== "") {
    lines.push(line.trimEnd());
  }

  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines - 1);
  return [...kept, truncate(lines.slice(maxLines - 1).join(" "), maxWidth, measure)];
}

// ---- PDF columns ----

export const MIN_FONT_SIZE = 7;
export const FONT_SIZES = [8, 7.5, MIN_FONT_SIZE];

// A text column never asks for more than this share of the page, however long its longest value is: the value
// wraps instead. And it can be narrowed down to this width (or its own, if shorter) before the font is made smaller.
const TEXT_MAX_SHARE = 0.4;
const TEXT_MIN_WIDTH = 56;

// What is known about a column before it is laid out: the widths of its header (bold) and of its widest value,
// both for a font size of 1 point, so the same measurements serve every font size.
export type ColumnMeasure = { kind: ColumnKind; headerUnit: number; widestUnit: number };

export type ColumnPlan = { fontSize: number; widths: number[] };

type Sized = { ideal: number; min: number; flexible: boolean };

function sizedAt(measure: ColumnMeasure, fontSize: number, tableWidth: number, padding: number): Sized {
  const header = measure.headerUnit * fontSize + 2 * padding;
  const content = measure.widestUnit * fontSize + 2 * padding;
  // Dates, flags and numbers are as wide as they are and no wider; only text can be narrowed.
  if (measure.kind !== "text") {
    const width = Math.max(header, content);
    return { ideal: width, min: width, flexible: false };
  }
  const ideal = Math.max(header, Math.min(content, TEXT_MAX_SHARE * tableWidth));
  const min = Math.max(header, Math.min(ideal, TEXT_MIN_WIDTH));
  return { ideal, min, flexible: ideal > min };
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

// Widths from the content. Short columns (a plot, a flag, a date, a status) keep the width their content needs.
// If everything fits, the spare room goes to the text columns. If not, the text columns are narrowed first, in
// proportion to how much room each can give up, and only if that is not enough is the font made smaller, never
// below MIN_FONT_SIZE. If even that does not fit, every column is squeezed in proportion.
export function planColumns(measures: ColumnMeasure[], tableWidth: number, padding: number): ColumnPlan {
  let smallest: Sized[] = [];
  for (const fontSize of FONT_SIZES) {
    const sized = measures.map((measure) => sizedAt(measure, fontSize, tableWidth, padding));
    smallest = sized;
    const ideal = sum(sized.map((s) => s.ideal));
    const min = sum(sized.map((s) => s.min));

    if (ideal <= tableWidth) {
      const spare = tableWidth - ideal;
      const flexible = sized.filter((s) => s.flexible);
      const heirs =
        flexible.length > 0
          ? flexible
          : measures.some((m) => m.kind === "text")
            ? sized.filter((_, i) => measures[i]?.kind === "text")
            : sized;
      const heirsIdeal = sum(heirs.map((s) => s.ideal));
      return {
        fontSize,
        widths: sized.map((s) =>
          heirs.includes(s) && heirsIdeal > 0 ? s.ideal + (spare * s.ideal) / heirsIdeal : s.ideal,
        ),
      };
    }
    if (min <= tableWidth) {
      const give = sum(sized.map((s) => s.ideal - s.min));
      const need = ideal - tableWidth;
      return {
        fontSize,
        widths: sized.map((s) => s.ideal - (give > 0 ? ((s.ideal - s.min) * need) / give : 0)),
      };
    }
  }
  const min = sum(smallest.map((s) => s.min));
  return {
    fontSize: MIN_FONT_SIZE,
    widths: smallest.map((s) => (min > 0 ? (s.min * tableWidth) / min : tableWidth / smallest.length)),
  };
}

// ---- spreadsheet columns ----

export const MIN_COLUMN_CHARACTERS = 8;
export const MAX_COLUMN_CHARACTERS = 60;
const COLUMN_PADDING = 2;
// A bold header is a little wider than the same text in the body, and the filter button takes room at its end.
const HEADER_FACTOR = 1.1;
const FILTER_BUTTON = 3;

function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

// How many characters wide a spreadsheet shows text: a letter or digit is one, a wide character (Chinese, Japanese,
// Korean, emoji) two, and a mark that sits on the letter before it (an Arabic vowel sign, an accent) or a joiner
// takes no room of its own. Counted per character, so Arabic is counted as the letters it shows.
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    if (/^[\p{Mn}\p{Me}\p{Cf}]$/u.test(char)) {
      continue;
    }
    width += isWide(char.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

// The widest line of a possibly multi-line value.
export function widestLine(text: string): number {
  return Math.max(0, ...text.split(/\r\n|\r|\n/).map(displayWidth));
}

export type ColumnWidth = { width: number; wraps: boolean };

// A column as wide as its longest value, header included, plus a little padding; at least MIN_COLUMN_CHARACTERS
// and at most MAX_COLUMN_CHARACTERS. A value wider than the maximum wraps within it.
export function columnWidth(headerWidth: number, longestValue: number): ColumnWidth {
  const wanted = Math.ceil(
    Math.max(headerWidth * HEADER_FACTOR + FILTER_BUTTON, longestValue + COLUMN_PADDING),
  );
  return {
    width: Math.min(MAX_COLUMN_CHARACTERS, Math.max(MIN_COLUMN_CHARACTERS, wanted)),
    wraps: wanted > MAX_COLUMN_CHARACTERS,
  };
}
