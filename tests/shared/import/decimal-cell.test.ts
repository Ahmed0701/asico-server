import { describe, expect, it } from "vitest";
import { decimalCell, type RawCell } from "../../../src/shared/import/index.js";

const KEY = "validation.qtyInvalid";
const options = { required: false, scale: 3, max: 999_999_999.999, key: KEY };
const ok = (value: number | undefined) => ({ ok: true, value });
const bad = (code: string, key: string) => ({ ok: false, error: { code, key } });

describe("decimalCell", () => {
  it.each([
    [0.001, 0.001],
    [1.005, 1.005],
    [2.5, 2.5],
    [12, 12],
    [999_999_999.999, 999_999_999.999],
    ["0.001", 0.001],
    ["1.005", 1.005],
    ["2.50", 2.5],
    [" 4.25 ", 4.25],
    ["999999999.999", 999_999_999.999],
    ["999999999.9990", 999_999_999.999],
  ] as [RawCell, number][])("reads %j as %s", (cell, expected) => {
    expect(decimalCell(cell, options)).toEqual(ok(expected));
  });

  it.each([
    ["zero", 0],
    ["zero as text", "0"],
    ["zero with decimals as text", "0.000"],
    ["a negative", -1],
    ["a negative as text", "-1"],
    ["a fourth decimal", 0.0004],
    ["a fourth decimal as text", "0.0004"],
    ["0.1 + 0.2", 0.1 + 0.2],
    ["0.1 + 0.2 as text", "0.30000000000000004"],
    ["one step above the maximum", 1_000_000_000],
    ["one step above the maximum as text", "1000000000"],
    ["a fourth decimal at the maximum", 999_999_999.9999],
    ["an exponent as text", "1e3"],
    ["an exponent number", 1e21],
    ["not a number", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["words", "many"],
    ["a comma as the decimal mark", "2,5"],
    ["a boolean", true],
    ["a date", new Date("2026-01-01T00:00:00.000Z")],
  ] as [string, RawCell][])("refuses %s with the message of the column", (_name, cell) => {
    expect(decimalCell(cell, options)).toEqual(bad("INVALID_VALUE", KEY));
  });

  it("takes the scale and the maximum it is given, both inclusive", () => {
    const narrow = { ...options, scale: 1, max: 5 };

    expect(decimalCell(5, narrow)).toEqual(ok(5));
    expect(decimalCell("4.9", narrow)).toEqual(ok(4.9));
    expect(decimalCell(5.1, narrow)).toEqual(bad("INVALID_VALUE", KEY));
    expect(decimalCell("0.25", narrow)).toEqual(bad("INVALID_VALUE", KEY));
    expect(decimalCell("0.2", narrow)).toEqual(ok(0.2));
  });

  it("treats an empty cell as missing when it is optional, and as REQUIRED when it is not", () => {
    expect(decimalCell(null, options)).toEqual(ok(undefined));
    expect(decimalCell(null, { ...options, required: true })).toEqual(bad("REQUIRED", "validation.required"));
  });

  it("refuses an unreadable cell", () => {
    expect(decimalCell({ unreadable: "formula-without-value" }, options)).toEqual(
      bad("UNREADABLE_CELL", "import.cellUnreadable"),
    );
  });
});
