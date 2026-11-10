import { describe, expect, it } from "vitest";
import { hasRtl, isRtlParagraph, visualRuns } from "../../../src/shared/export/bidi.js";
import { minorUnitsOf } from "../../../src/shared/validation/decimal.js";
import {
  amountNumberFormat,
  currencyDigits,
  formatAmount,
  formatBoolean,
  formatCell,
  formatDate,
  formatDateTime,
  formatMoney,
  majorUnitsText,
  moneyCell,
  protectFormula,
} from "../../../src/shared/export/format.js";

describe("dates", () => {
  it("formats a date as YYYY-MM-DD in UTC, whatever the server's time zone", () => {
    expect(formatDate(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-05");
    expect(formatDate(new Date("2026-12-31T23:59:59.999Z"))).toBe("2026-12-31");
    expect(formatDate(new Date("2026-03-04T23:30:00.000+02:00"))).toBe("2026-03-04");
  });

  it("formats a timestamp as YYYY-MM-DD HH:mm UTC", () => {
    expect(formatDateTime(new Date("2026-03-04T05:06:07.890Z"))).toBe("2026-03-04 05:06 UTC");
    expect(formatDateTime(new Date("2026-03-05T00:00:00.000Z"))).toBe("2026-03-05 00:00 UTC");
    expect(formatDateTime(new Date("2026-03-04T23:59:59.999Z"))).toBe("2026-03-04 23:59 UTC");
  });

  it("formats booleans as Yes or No", () => {
    expect(formatBoolean(true)).toBe("Yes");
    expect(formatBoolean(false)).toBe("No");
  });

  it("formats a cell by its kind", () => {
    const at = new Date("2026-03-04T05:06:07.890Z");
    expect(formatCell(at, "date")).toBe("2026-03-04");
    expect(formatCell(at, "datetime")).toBe("2026-03-04 05:06 UTC");
    expect(formatCell(true, "boolean")).toBe("Yes");
    expect(formatCell(7, "integer")).toBe("7");
    expect(formatCell("007", "text")).toBe("007");
    expect(formatCell(null, "text")).toBe("");
  });
});

describe("protectFormula", () => {
  it.each(["=1+1", "+1", "-1", "@x", "\t1", "\r1"])("prefixes %j", (value) => {
    expect(protectFormula(value)).toBe(`'${value}`);
  });

  it.each(["", "abc", "a=b", "1+1", "1-1", "P-001", " =x", "0100 123", "'1", "'abc"])(
    "leaves %j alone",
    (value) => {
      expect(protectFormula(value)).toBe(value);
    },
  );
});

describe("protectFormula on a text that has apostrophes already", () => {
  it.each(["'=1", "''=1", "'''+x"])("adds one more to %j, so that it comes back", (value) => {
    expect(protectFormula(value)).toBe(`'${value}`);
  });
});

describe("amounts as the export writes them", () => {
  it("knows how many decimals a currency has", () => {
    expect(currencyDigits("EGP")).toBe(2);
    expect(currencyDigits("USD")).toBe(2);
    expect(currencyDigits("KWD")).toBe(3);
    expect(currencyDigits("JPY")).toBe(0);
  });

  it("writes minor units as exact decimal text", () => {
    expect(majorUnitsText(125050, 2)).toBe("1250.50");
    expect(majorUnitsText(5, 2)).toBe("0.05");
    expect(majorUnitsText(0, 2)).toBe("0.00");
    expect(majorUnitsText(5, 0)).toBe("5");
    expect(majorUnitsText(1234567, 3)).toBe("1234.567");
    expect(majorUnitsText(Number.MAX_SAFE_INTEGER, 2)).toBe("90071992547409.91");
  });

  it("writes a budget as text with its currency, or nothing without a budget", () => {
    expect(formatMoney(125050, "EGP")).toBe("1250.50 EGP");
    expect(formatMoney(5, "JPY")).toBe("5 JPY");
    expect(formatMoney(1250050, "KWD")).toBe("1250.050 KWD");
    expect(formatMoney(null, "EGP")).toBe("");
    expect(formatMoney(100, null)).toBe("");
  });

  it.each([
    [0, "EGP", 0],
    [29, "EGP", 0.29],
    [125050, "EGP", 1250.5],
    [125000050, "USD", 1250000.5],
    [5, "JPY", 5],
    [1250050, "KWD", 1250.05],
  ])("gives %i %s as the number %d in a cell", (minor, currency, number) => {
    expect(moneyCell(minor, currency)).toBe(number);
  });

  it("gives the exact text when a double cannot hold the amount", () => {
    expect(moneyCell(Number.MAX_SAFE_INTEGER, "EGP")).toBe("90071992547409.91");
  });

  it("gives nothing without a budget or without a currency", () => {
    expect(moneyCell(null, "EGP")).toBeNull();
    expect(moneyCell(100, null)).toBeNull();
    expect(moneyCell(null, null)).toBeNull();
  });

  it("writes an amount with two decimals, and a third when there is one", () => {
    expect(formatAmount(2.5)).toBe("2.50");
    expect(formatAmount(1250000)).toBe("1,250,000.00");
    expect(formatAmount(0.125)).toBe("0.125");
  });

  it("writes an amount with the decimals of its currency when it is given them", () => {
    expect(formatAmount(1250.5, 3)).toBe("1,250.500");
    expect(formatAmount(1250.5, 2)).toBe("1,250.50");
    expect(formatAmount(1250, 0)).toBe("1,250");
    expect(formatAmount(0.001, 3)).toBe("0.001");
    // Never more decimals than the currency has.
    expect(formatAmount(1250.1234, 2)).toBe("1,250.12");
    expect(formatAmount(1250.6, 0)).toBe("1,251");
  });

  it.each([
    [3, "#,##0.000"],
    [2, "#,##0.00"],
    [0, "#,##0"],
  ])("gives %i decimals the spreadsheet format %s", (digits, format) => {
    expect(amountNumberFormat(digits)).toBe(format);
  });
});

// The export writes minor units as a number in major units; the import reads that number back with the decimals of the same
// currency. Every amount must come back as the same minor units, for a currency of any number of decimals.
describe("an amount written by the export is read back by the import exactly", () => {
  const amounts = [0, 1, 5, 9, 10, 29, 99, 100, 999, 1000, 1234, 125050, 1250500, 123_456_789, 1_234_567_890];
  const edges = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1, 2 ** 52 + 1, 9_007_199_254_740_000];

  it.each(["KWD", "EGP", "USD", "JPY", "BHD", "OMR"])("%s: %s", (currency) => {
    const digits = currencyDigits(currency);

    for (const minor of [...amounts, ...edges]) {
      const cell = moneyCell(minor, currency);
      expect(minorUnitsOf(cell, digits), `${minor} ${currency} as ${String(cell)}`).toBe(minor);
    }
  });

  it("0.001 KWD is 1 fil, as the number 0.001 in the cell and as the text 0.001", () => {
    expect(moneyCell(1, "KWD")).toBe(0.001);
    expect(majorUnitsText(1, 3)).toBe("0.001");
    expect(minorUnitsOf(0.001, 3)).toBe(1);
    expect(minorUnitsOf("0.001", 3)).toBe(1);
    expect(formatMoney(1, "KWD")).toBe("0.001 KWD");
  });

  it("a double that cannot hold the amount travels as exact text, which the import reads the same", () => {
    expect(moneyCell(Number.MAX_SAFE_INTEGER, "KWD")).toBe("9007199254740.991");
    expect(moneyCell(Number.MAX_SAFE_INTEGER, "EGP")).toBe("90071992547409.91");
    // A currency without decimals needs no text: the safe integer itself is a number.
    expect(moneyCell(Number.MAX_SAFE_INTEGER, "JPY")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("bidi", () => {
  it("knows which text has a right-to-left script", () => {
    expect(hasRtl("Nile Builders")).toBe(false);
    expect(hasRtl("شركة")).toBe(true);
    expect(hasRtl("Nile شركة")).toBe(true);
    expect(hasRtl("P-001 123")).toBe(false);
  });

  it("leaves left-to-right text as one run", () => {
    expect(visualRuns("Delta Works P-001")).toEqual([{ text: "Delta Works P-001", rtl: false }]);
    expect(visualRuns("")).toEqual([]);
  });

  it("keeps pure Arabic as one right-to-left run in reading order", () => {
    expect(visualRuns("تقرير الموقع الجديد")).toEqual([{ text: "تقرير الموقع الجديد", rtl: true }]);
  });

  it("orders a right-to-left sentence with Latin and digits the way it is read", () => {
    const runs = visualRuns("شركة النيل Nile 7 للمقاولات");

    // Left to right on the page: the last Arabic words, the Latin run, then the first Arabic words.
    expect(runs.map((run) => run.text.trim())).toEqual(["للمقاولات", "Nile 7", "شركة النيل"]);
    expect(runs.map((run) => run.rtl)).toEqual([true, false, true]);
  });

  it("keeps a left-to-right sentence first when it starts with Latin", () => {
    const runs = visualRuns("Nile Builders - شركة النيل");

    expect(runs[0]).toMatchObject({ rtl: false });
    expect(runs[0]?.text.startsWith("Nile Builders")).toBe(true);
    expect(runs[runs.length - 1]).toMatchObject({ text: "شركة النيل", rtl: true });
  });

  it("puts digits inside an Arabic sentence in their own left-to-right run", () => {
    const runs = visualRuns("مشروع رقم 123 القاهرة");

    expect(runs.map((run) => run.text.trim())).toEqual(["القاهرة", "123", "مشروع رقم"]);
  });

  it("mirrors brackets inside right-to-left text", () => {
    const text = visualRuns("(شركة)")
      .map((run) => run.text)
      .join("");

    expect(text).toBe(")شركة(");
  });

  it("detects a right-to-left paragraph by its first strong character", () => {
    expect(isRtlParagraph("شركة النيل Nile")).toBe(true);
    expect(isRtlParagraph("Nile شركة")).toBe(false);
    expect(isRtlParagraph("123")).toBe(false);
    expect(isRtlParagraph("")).toBe(false);
  });
});
