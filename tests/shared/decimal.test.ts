import { describe, expect, it } from "vitest";
import { isTooFarAhead } from "../../src/shared/utils/day.js";
import { decimalWithin, minorUnitsOf } from "../../src/shared/validation/decimal.js";

describe("decimalWithin: the number as it is written, never rounded", () => {
  it.each([
    [0, 3, 0],
    [1, 3, 1],
    [0.001, 3, 0.001],
    [1.005, 3, 1.005],
    [2.5, 3, 2.5],
    [123456.789, 3, 123456.789],
    [999_999_999.999, 3, 999_999_999.999],
    [0.5, 1, 0.5],
    ["0", 3, 0],
    ["7", 3, 7],
    ["0.001", 3, 0.001],
    ["1.005", 3, 1.005],
    ["2.50", 3, 2.5],
    ["1.5000", 3, 1.5],
    ["1.000", 3, 1],
    ["999999999.9990", 3, 999_999_999.999],
    [" 4.25 ", 3, 4.25],
    ["007.5", 3, 7.5],
  ])("reads %j with %i decimals as %s", (input, scale, expected) => {
    expect(decimalWithin(input, scale)).toBe(expected);
  });

  it.each([
    [0.0004, 3],
    [0.0005, 3],
    [1.0001, 3],
    [0.1 + 0.2, 3],
    [0.30000000000000004, 3],
    [999_999_999.9999, 3],
    [0.15, 1],
    ["0.0004", 3],
    ["1.0001", 3],
    ["0.30000000000000004", 3],
    ["999999999.9999", 3],
  ])("refuses %j with %i decimals: a fourth decimal is not rounded away", (input, scale) => {
    expect(decimalWithin(input, scale)).toBeUndefined();
  });

  it.each([
    -1,
    -0.001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e21,
    1e-7,
    "-1",
    "+2",
    "1e3",
    "1E3",
    "2,5",
    "1,000",
    "1 000",
    ".5",
    "5.",
    ".",
    "",
    "   ",
    "many",
    "Infinity",
    "NaN",
    "0x10",
    true,
    false,
    null,
    undefined,
    {},
    [],
    [1],
    new Date(),
  ])("refuses %j: not a plain non-negative decimal", (input) => {
    expect(decimalWithin(input, 3)).toBeUndefined();
  });

  it("refuses a bigint", () => {
    expect(decimalWithin(BigInt(10), 3)).toBeUndefined();
  });

  it("treats minus zero as the plain 0 it is written as", () => {
    expect(decimalWithin(-0, 3)).toBe(0);
  });

  it("counts the decimals of the text, not the digits: a zero scale takes whole numbers only", () => {
    expect(decimalWithin("12", 0)).toBe(12);
    expect(decimalWithin("12.0", 0)).toBe(12);
    expect(decimalWithin("12.5", 0)).toBeUndefined();
  });
});

describe("isTooFarAhead: the limit is the end of tomorrow's UTC day, counted from midnight", () => {
  it.each([
    // After midnight of tomorrow: too far, whatever the hour of "now" is.
    ["2026-10-27T12:00:00.000Z", "2026-10-28T00:00:00.001Z", true],
    ["2026-10-27T12:00:00.000Z", "2026-10-28T06:00:00.000Z", true],
    ["2026-10-27T00:00:00.000Z", "2026-10-28T00:30:00.000Z", true],
    ["2026-10-27T23:59:59.999Z", "2026-10-28T00:00:00.000Z", false],
  ])("at %s the instant %s is too far ahead: %s", (now, target, tooFar) => {
    expect(isTooFarAhead(new Date(target), new Date(now))).toBe(tooFar);
  });
});

describe("isTooFarAhead: a day may be written up to tomorrow (UTC), not beyond", () => {
  const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

  it.each([
    ["2026-10-27T00:00:00.000Z", "2026-10-27", false],
    ["2026-10-27T00:00:00.000Z", "2026-10-28", false],
    ["2026-10-27T00:00:00.000Z", "2026-10-29", true],
    ["2026-10-27T23:59:59.999Z", "2026-10-28", false],
    ["2026-10-27T23:59:59.999Z", "2026-10-29", true],
    ["2026-10-28T00:00:00.000Z", "2026-10-29", false],
    ["2026-10-28T00:00:00.000Z", "2026-10-30", true],
    ["2026-10-27T12:00:00.000Z", "2020-01-01", false],
    ["2026-12-31T22:00:00.000Z", "2027-01-01", false],
    ["2026-12-31T22:00:00.000Z", "2027-01-02", true],
    ["2028-02-28T10:00:00.000Z", "2028-02-29", false],
    ["2028-02-28T10:00:00.000Z", "2028-03-01", true],
  ])("at %s the day %s is too far ahead: %s", (now, target, tooFar) => {
    expect(isTooFarAhead(day(target), new Date(now))).toBe(tooFar);
  });
});

describe("minorUnitsOf: major units to minor units, exactly", () => {
  it.each([
    [0, 0],
    ["0", 0],
    [1, 100],
    [0.29, 29],
    [1.1, 110],
    [19.99, 1999],
    [1250000.5, 125000050],
    ["1250000.50", 125000050],
    ["1250000.5", 125000050],
    ["1250000.500", 125000050],
    ["007.05", 705],
    [" 12 ", 1200],
    ["0.07", 7],
    [90_071_992_547_409.9, 9_007_199_254_740_990],
    ["90071992547409.91", 9_007_199_254_740_991],
  ])("reads %j as %s minor units", (input, expected) => {
    expect(minorUnitsOf(input, 2)).toBe(expected);
  });

  // The scale is the decimals of the currency: three for KWD, none for JPY.
  it.each([
    [0.001, 3, 1],
    [0, 3, 0],
    [1250.5, 3, 1_250_500],
    ["1234.567", 3, 1_234_567],
    [1.5, 3, 1500],
    [4.35, 3, 4350],
    ["9007199254740.991", 3, Number.MAX_SAFE_INTEGER],
    [1250, 0, 1250],
    ["5", 0, 5],
    [9_007_199_254_740_991, 0, Number.MAX_SAFE_INTEGER],
  ])("reads %j with %i decimals as %s minor units", (input, scale, expected) => {
    expect(minorUnitsOf(input, scale)).toBe(expected);
  });

  it.each([
    [0.0001, 3],
    ["1.2345", 3],
    ["9007199254740.992", 3],
    [0.5, 0],
    ["1.0001", 3],
    [9_007_199_254_740_992, 0],
  ])("refuses %j with %i decimals", (input, scale) => {
    expect(minorUnitsOf(input, scale)).toBeUndefined();
  });

  it("never multiplies: 0.29 and 4.35 and 1.005-like sums do not drift", () => {
    expect(minorUnitsOf(4.35, 2)).toBe(435);
    expect(minorUnitsOf(8.2, 2)).toBe(820);
    expect(minorUnitsOf(0.57, 2)).toBe(57);
  });

  it.each([
    [1.005, "a third decimal"],
    ["1.234", "a third decimal"],
    [0.1 + 0.2, "a float with seventeen decimals"],
    [-1, "negative"],
    ["-0.5", "negative text"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "infinity"],
    ["1e3", "an exponent"],
    [1e21, "a number written with an exponent"],
    ["1,250", "a thousands separator"],
    ["12 EGP", "a unit"],
    ["", "nothing"],
    ["abc", "text"],
    [90_071_992_547_409.92, "more than a safe integer of minor units"],
    ["90071992547409.92", "more than a safe integer of minor units, as text"],
    ["99999999999999999999", "twenty digits"],
    [null, "null"],
    [true, "a boolean"],
    [new Date(0), "a date"],
  ])("refuses %j (%s)", (...args) => {
    expect(minorUnitsOf(args[0], 2)).toBeUndefined();
  });

  it("reads other scales: three decimals for a currency with three minor places", () => {
    expect(minorUnitsOf("1.234", 3)).toBe(1234);
    expect(minorUnitsOf("1.2345", 3)).toBeUndefined();
    expect(minorUnitsOf("5", 0)).toBe(5);
    expect(minorUnitsOf("5.1", 0)).toBeUndefined();
  });
});
