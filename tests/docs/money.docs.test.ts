import { describe, expect, it } from "vitest";
import { currencyDigits } from "../../src/shared/export/format.js";
import { minorUnitsOf } from "../../src/shared/validation/decimal.js";
import { blocks, files, read } from "./source.js";

// The documents state amounts in minor units next to the amount they stand for ("`1250500` is 1,250.500 KWD", "`1250000.5` in
// EGP is 125,000,050 piastres"). Each statement is checked against the scale of its currency, and every `budgetMinor` of a JSON
// example must be one of the stated pairs, so an example cannot drift from the amount it is said to show. The default currency
// is KWD: no document calls it pounds or EGP.

const documents = [...files("docs", ".md"), "README.md"].map((path) => ({ path, text: read(path) }));

const UNIT_OF: Record<string, string> = {
  fils: "KWD",
  fil: "KWD",
  piastres: "EGP",
  cents: "USD",
  yen: "JPY",
};

type Pair = { path: string; minor: number; amount: string; currency: string };

const amountText = (text: string) => text.replaceAll(",", "");

// "`1250500` is 1,250.500 KWD", and "`12550` for 125.50 EGP or 12.550 KWD".
function stated(): Pair[] {
  const found: Pair[] = [];
  const pattern =
    /`(\d+)` (?:is|for) (\d[\d,]*(?:\.\d+)?) ([A-Z]{3})\b(?: or (\d[\d,]*(?:\.\d+)?) ([A-Z]{3})\b)?/g;
  for (const { path, text } of documents) {
    for (const match of text.matchAll(pattern)) {
      found.push({ path, minor: Number(match[1]), amount: amountText(match[2]!), currency: match[3]! });
      if (match[4] !== undefined) {
        found.push({ path, minor: Number(match[1]), amount: amountText(match[4]), currency: match[5]! });
      }
    }
  }
  return found;
}

// "`1250000.5` in KWD is 1,250,000,500 fils".
function converted(): { path: string; major: string; currency: string; minor: string; unit: string }[] {
  const found: ReturnType<typeof converted> = [];
  const pattern = /`(\d[\d.]*)` in ([A-Z]{3}) is (\d[\d,]*) (fils|fil|piastres|cents|yen)\b/g;
  for (const { path, text } of documents) {
    for (const match of text.matchAll(pattern)) {
      found.push({
        path,
        major: match[1]!,
        currency: match[2]!,
        minor: amountText(match[3]!),
        unit: match[4]!,
      });
    }
  }
  return found;
}

// Every object of the JSON examples that has a budgetMinor and a currency.
function exampleBudgets(): { path: string; minor: number; currency: string }[] {
  const found: ReturnType<typeof exampleBudgets> = [];
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, path));
    } else if (value !== null && typeof value === "object") {
      const object = value as Record<string, unknown>;
      if (typeof object["budgetMinor"] === "number" && typeof object["currency"] === "string") {
        found.push({ path, minor: object["budgetMinor"], currency: object["currency"] });
      }
      Object.values(object).forEach((item) => walk(item, path));
    }
  };
  for (const { path, text } of documents) {
    for (const { body } of blocks(text, "json")) {
      walk(JSON.parse(body), path);
    }
  }
  return found;
}

describe("the amounts in the documents", () => {
  it("finds the statements it checks (a rename of the wording must not empty this test)", () => {
    expect(stated().length).toBeGreaterThanOrEqual(4);
    expect(converted().length).toBeGreaterThanOrEqual(4);
    expect(exampleBudgets().length).toBeGreaterThanOrEqual(1);
  });

  it.each(
    stated().map((pair) => [`${pair.path}: ${pair.minor} is ${pair.amount} ${pair.currency}`, pair] as const),
  )("%s", (_name, pair) => {
    const digits = currencyDigits(pair.currency);
    const decimals = pair.amount.split(".")[1] ?? "";

    expect(decimals.length, "the amount is written with the decimals of its currency").toBe(digits);
    expect(minorUnitsOf(pair.amount, digits)).toBe(pair.minor);
  });

  it.each(
    converted().map(
      (item) =>
        [`${item.path}: ${item.major} in ${item.currency} is ${item.minor} ${item.unit}`, item] as const,
    ),
  )("%s", (_name, item) => {
    expect(minorUnitsOf(item.major, currencyDigits(item.currency))).toBe(Number(item.minor));
    expect(UNIT_OF[item.unit], "the unit belongs to the currency").toBe(item.currency);
  });

  it.each(
    exampleBudgets().map(
      (item) => [`${item.path}: budgetMinor ${item.minor} ${item.currency}`, item] as const,
    ),
  )("a JSON example with %s is one of the stated pairs", (_name, item) => {
    const pairs = stated().filter((pair) => pair.currency === item.currency && pair.minor === item.minor);

    expect(pairs, "say what the example's budget is: `<minor>` is <amount> <CODE>").not.toHaveLength(0);
  });

  it("calls no currency the default but KWD, and never speaks of pounds", () => {
    for (const { path, text } of documents) {
      expect(text, path).not.toMatch(/\bpounds?\b/i);
      expect(text, path).not.toMatch(
        /default\s+`?EGP\b|\bEGP`?\s+(?:unless|is the default)|empty (?:cell )?means EGP|leave it empty for EGP/i,
      );
    }
  });
});
