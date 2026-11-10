import bidiFactory, { type Bidi } from "bidi-js";

// The package is CommonJS whose types describe an ES default export; under Node the default import is the
// factory itself, so it is typed as what it is.
const bidi = (bidiFactory as unknown as () => Bidi)();

// Arabic, Hebrew and their presentation forms. Text without any of these is drawn as it is.
const RTL_CHARACTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;

export type VisualRun = { text: string; rtl: boolean };

export function hasRtl(text: string): boolean {
  return RTL_CHARACTER.test(text);
}

// Splits text into runs of one direction and puts them in the order they are drawn, left to right
// (the Unicode bidirectional algorithm). Each run keeps its characters in reading order: the PDF library
// shapes Arabic letters correctly but does not reorder, so a run in a right-to-left script is drawn with
// the `rtla` feature and the run order here does the rest.
// `direction` is the direction of the paragraph the text belongs to; a line cut out of a longer right-to-left
// value keeps that direction even if its own first letter is Latin.
export function visualRuns(text: string, direction: "auto" | "ltr" | "rtl" = "auto"): VisualRun[] {
  if (text === "") {
    return [];
  }
  if (!hasRtl(text)) {
    return [{ text, rtl: false }];
  }
  const embedding = bidi.getEmbeddingLevels(text, direction === "auto" ? "auto" : direction);
  const { levels } = embedding;
  const mirrored = bidi.getMirroredCharactersMap(text, levels);
  const characters = Array.from(text);

  // Characters are processed by UTF-16 index, matching the levels array.
  const units: { char: string; level: number }[] = [];
  let index = 0;
  for (const char of characters) {
    const level = levels[index] ?? 0;
    units.push({ char: level % 2 === 1 ? (mirrored.get(index) ?? char) : char, level });
    index += char.length;
  }

  const runs: { text: string; level: number }[] = [];
  for (const unit of units) {
    const last = runs[runs.length - 1];
    if (last && last.level === unit.level) {
      last.text += unit.char;
    } else {
      runs.push({ text: unit.char, level: unit.level });
    }
  }

  // Rule L2: from the highest level down to the lowest odd level, reverse every sequence of runs at or above it.
  const levelsPresent = runs.map((run) => run.level);
  const highest = Math.max(...levelsPresent);
  const lowestOdd = Math.min(...levelsPresent.filter((level) => level % 2 === 1));
  if (Number.isFinite(lowestOdd)) {
    for (let level = highest; level >= lowestOdd; level--) {
      for (let start = 0; start < runs.length;) {
        if ((runs[start]?.level ?? 0) < level) {
          start++;
          continue;
        }
        let end = start;
        while (end < runs.length && (runs[end]?.level ?? 0) >= level) {
          end++;
        }
        const reversed = runs.slice(start, end).reverse();
        runs.splice(start, end - start, ...reversed);
        start = end;
      }
    }
  }
  return runs.map((run) => ({ text: run.text, rtl: run.level % 2 === 1 }));
}

// Whether the text as a whole reads right to left (its first strong character is in an RTL script).
export function isRtlParagraph(text: string): boolean {
  if (!hasRtl(text)) {
    return false;
  }
  const { paragraphs } = bidi.getEmbeddingLevels(text, "auto");
  return (paragraphs[0]?.level ?? 0) % 2 === 1;
}
