// A number that is meant to be a decimal with a fixed number of places (a DECIMAL(p, s) column). JavaScript numbers are
// binary, so 0.1 + 0.2 is 0.30000000000000004 and 1.005 is not exactly 1.005. The rule is therefore about how the value
// is WRITTEN: its shortest text must have at most `scale` decimals. 1.005 is written "1.005" (three decimals, accepted);
// 0.1 + 0.2 is written with seventeen (refused); 0.0004 has four (refused). A value never gets rounded to fit.

const PLAIN_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

// The number written as `input` (a number, or the text of one: digits with an optional point and decimals), when it has
// at most `scale` decimals; undefined otherwise. Trailing zeros of a text do not count ("1.5000" is 1.5). Negative,
// exponent and non-finite forms are refused: they are not a quantity anyone types.
export function decimalWithin(input: unknown, scale: number): number | undefined {
  const text = typeof input === "number" && Number.isFinite(input) ? String(input) : input;
  if (typeof text !== "string") {
    return undefined;
  }
  const match = PLAIN_DECIMAL.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const decimals = (match[2] ?? "").replace(/0+$/, "");
  if (decimals.length > scale) {
    return undefined;
  }
  return Number(decimals === "" ? match[1] : `${match[1]}.${decimals}`);
}

// An amount written in major units (dinars, pounds, dollars) as minor units (fils, piastres, cents): the number written as `input` (a
// number, or the text of one) with at most `scale` decimals, as a whole number of minor units. It is built from the digits,
// not by multiplying, so 0.29 is 29 and not 28.999999999999996, and an amount that does not fit in a safe integer (more than
// 15 digits of minor units) is undefined, never rounded. Zero is an amount; negative, exponent and non-finite forms are not.
export function minorUnitsOf(input: unknown, scale: number): number | undefined {
  const text = typeof input === "number" && Number.isFinite(input) ? String(input) : input;
  if (typeof text !== "string") {
    return undefined;
  }
  const match = PLAIN_DECIMAL.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const decimals = (match[2] ?? "").replace(/0+$/, "");
  if (decimals.length > scale) {
    return undefined;
  }
  const minor = Number(`${match[1]}${decimals.padEnd(scale, "0")}`);
  return Number.isSafeInteger(minor) ? minor : undefined;
}
