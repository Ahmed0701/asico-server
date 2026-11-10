import { describe, expect, it } from "vitest";
import {
  areaCell,
  buildAreaIndex,
  buildPartyIndex,
  minorUnitsCell,
  partyCell,
  textOrNumberCell,
  type AreaRecord,
  type PartyRecord,
} from "../../../src/shared/import/index.js";
import {
  villaOwnerNameField,
  villaTextField,
} from "../../../src/modules/villas/validators/villas.validators.js";

// The cells of the villa import: codes people type as numbers, money in pounds, and references by name or phone.
const ok = <T>(value: T) => ({ ok: true, value });
const bad = (code: string, key: string) => ({ ok: false, error: { code, key } });

describe("textOrNumberCell", () => {
  const take = (cell: unknown, required = true) =>
    textOrNumberCell(cell as never, villaTextField, { required });

  it.each([
    [2235, "2235"],
    [4, "4"],
    [30, "30"],
    [0, "0"],
    [1_000_000, "1000000"],
    [Number.MAX_SAFE_INTEGER, "9007199254740991"],
  ])("reads the number %j as the text %j, with no decimals, exponent or separators", (cell, text) => {
    expect(take(cell)).toEqual(ok(text));
  });

  it("reads a whole number written with a decimal point in the file (4.0) as the integer it is", () => {
    expect(take(4.0)).toEqual(ok("4"));
  });

  it.each([
    2.5,
    0.1,
    -1,
    -2235,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 2,
    1e21,
    1e300,
  ])("refuses the number %j as an invalid value", (cell) => {
    expect(take(cell)).toEqual(bad("INVALID_VALUE", "import.cellNumberInvalid"));
  });

  it("keeps the leading and trailing spaces of a text cell out, as any text", () => {
    expect(take("  A-12  ")).toEqual(ok("A-12"));
    expect(take("4")).toEqual(ok("4"));
  });

  it("takes an Arabic text as it is", () => {
    expect(textOrNumberCell("  محمد أحمد  ", villaOwnerNameField, { required: false })).toEqual(
      ok("محمد أحمد"),
    );
  });

  it("applies the text rules to a number too: too long digits are an invalid value of the field", () => {
    expect(take(Number("9".repeat(15)))).toEqual(ok("9".repeat(15)));
    const long = textOrNumberCell("x".repeat(51), villaTextField, { required: true });
    expect(long).toEqual(bad("INVALID_VALUE", "validation.textLength"));
  });

  it("applies the owner name's length to a number cell", () => {
    expect(textOrNumberCell(123, villaOwnerNameField, { required: false })).toEqual(ok("123"));
  });

  it("an empty cell is required or nothing, as for any text", () => {
    expect(take(null)).toEqual(bad("REQUIRED", "validation.required"));
    expect(take(null, false)).toEqual(ok(undefined));
  });

  it("a date, a boolean and an unreadable cell are not text and not numbers", () => {
    expect(take(new Date("2026-01-01T00:00:00Z"))).toEqual(bad("NOT_TEXT", "import.cellNotText"));
    expect(take(true)).toEqual(bad("NOT_TEXT", "import.cellNotText"));
    expect(take({ unreadable: "error-value" })).toEqual(bad("UNREADABLE_CELL", "import.cellUnreadable"));
  });

  it("a whitespace-only text is an invalid value of the field", () => {
    expect(take("   ")).toEqual(bad("INVALID_VALUE", "validation.textLength"));
  });
});

describe("minorUnitsCell", () => {
  const take = (cell: unknown, required = false) =>
    minorUnitsCell(cell as never, { required, scale: 2, key: "import.budgetInvalid" });

  it.each([
    [1_500_000, 150_000_000],
    [1250.5, 125_050],
    [0.29, 29],
    [0, 0],
    ["1250.50", 125_050],
    [" 1000 ", 100_000],
    ["12", 1200],
    ["0.07", 7],
  ])("reads %j pounds as %j piastres", (cell, minor) => {
    expect(take(cell)).toEqual(ok(minor));
  });

  it.each([
    -1,
    "-5",
    0.001,
    "1.234",
    "1e3",
    "abc",
    "12 EGP",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    90_071_992_547_410,
    true,
    new Date("2026-01-01T00:00:00Z"),
  ])("refuses %j as an invalid budget", (cell) => {
    expect(take(cell)).toEqual(bad("INVALID_VALUE", "import.budgetInvalid"));
  });

  it("keeps the decimals the scale allows, and the message it is given", () => {
    const at = (cell: unknown, scale: number) =>
      minorUnitsCell(cell as never, { required: false, scale, key: "import.somethingElse" });

    expect(at("12", 0)).toEqual(ok(12));
    expect(at("12.5", 0)).toEqual(bad("INVALID_VALUE", "import.somethingElse"));
    expect(at("1.234", 3)).toEqual(ok(1234));
    expect(at(1.2345, 3)).toEqual(bad("INVALID_VALUE", "import.somethingElse"));
  });

  it("an empty cell is nothing when optional and required otherwise", () => {
    expect(take(null)).toEqual(ok(undefined));
    expect(take(null, true)).toEqual(bad("REQUIRED", "validation.required"));
  });

  it("an unreadable cell is reported as such", () => {
    expect(take({ unreadable: "formula-without-value" })).toEqual(
      bad("UNREADABLE_CELL", "import.cellUnreadable"),
    );
  });
});

describe("partyCell", () => {
  const party = (id: string, name: string, phone: string, status: PartyRecord["status"] = "ACTIVE") => ({
    id,
    name,
    phone,
    status,
  });
  const index = buildPartyIndex([
    party("p1", "Hamdy Saad", "0100 111 2222"),
    party("p2", "Nile Works", "0111-333-4444"),
    party("p3", "Old Co", "0122 555 6666", "INACTIVE"),
    party("p4", "Twin", "0100 000 0001"),
    party("p5", "TWIN", "0100 000 0002"),
    party("p6", "Mix", "0155 777 8888"),
    party("p7", "0155 777 8888", "0100 000 0003"),
  ]);
  const options = {
    required: false,
    notFoundKey: "import.civilEngineerNotFound",
    inactiveKey: "import.partyInactive",
  };
  const take = (cell: unknown, extra: Partial<typeof options> = {}) =>
    partyCell(cell as never, index, { ...options, ...extra });

  it("finds a party by name, ignoring case and extra spaces", () => {
    expect(take("  hamdy   SAAD ")).toEqual(ok("p1"));
  });

  it("finds a party by phone, ignoring spaces and dashes in either place", () => {
    expect(take("01001112222")).toEqual(ok("p1"));
    expect(take("0100-111-2222")).toEqual(ok("p1"));
    expect(take("0111 333 4444")).toEqual(ok("p2"));
  });

  it("does not find an unknown name or phone", () => {
    expect(take("Nobody")).toEqual(bad("REFERENCE_NOT_FOUND", "import.civilEngineerNotFound"));
    expect(take("0100 999 9999", { notFoundKey: "import.contractorNotFound" })).toEqual(
      bad("REFERENCE_NOT_FOUND", "import.contractorNotFound"),
    );
  });

  it("two parties of one name are ambiguous, never a guess", () => {
    expect(take("twin")).toEqual(bad("AMBIGUOUS_REFERENCE", "import.partyAmbiguous"));
  });

  it("one party's name that is another's phone is ambiguous", () => {
    expect(take("0155 777 8888")).toEqual(bad("AMBIGUOUS_REFERENCE", "import.partyAmbiguous"));
  });

  it("one party named by both its name and its phone is that one party", () => {
    const same = buildPartyIndex([party("p9", "0100 123 4567", "0100 123 4567")]);
    // The text matches the name as it is written and the phone without its spaces and dashes: one party, found twice.
    expect(partyCell("0100 123 4567", same, options)).toEqual(ok("p9"));
    expect(partyCell("0100-123-4567", same, options)).toEqual(ok("p9"));
  });

  it("two parties of one phone, written differently, are ambiguous", () => {
    const sharing = buildPartyIndex([
      party("s1", "First", "0100 777 0000"),
      party("s2", "Second", "0100-777-0000"),
    ]);
    expect(partyCell("01007770000", sharing, options)).toEqual(
      bad("AMBIGUOUS_REFERENCE", "import.partyAmbiguous"),
    );
  });

  it("refuses an inactive party with the message given", () => {
    expect(take("Old Co")).toEqual(bad("INVALID_VALUE", "import.partyInactive"));
  });

  it("a number cell is not text: a phone typed into a General cell lost its leading zero", () => {
    expect(take(1001112222)).toEqual(bad("NOT_TEXT", "import.cellNotText"));
    expect(take(true)).toEqual(bad("NOT_TEXT", "import.cellNotText"));
  });

  it("an empty cell is nothing when optional and required otherwise", () => {
    expect(take(null)).toEqual(ok(undefined));
    expect(take(null, { required: true })).toEqual(bad("REQUIRED", "validation.required"));
  });

  it("an unreadable cell is reported as such", () => {
    expect(take({ unreadable: "error-value" })).toEqual(bad("UNREADABLE_CELL", "import.cellUnreadable"));
  });

  it("matches an Arabic name", () => {
    const arabic = buildPartyIndex([party("a1", "حمدي سعد", "0100 111 2222")]);
    expect(partyCell("  حمدي   سعد ", arabic, options)).toEqual(ok("a1"));
  });
});

describe("areaCell", () => {
  const areas: AreaRecord[] = [
    { id: "a1", name: "New Cairo", city: "Cairo" },
    { id: "a2", name: "Palm Hills", city: "Giza" },
    { id: "a3", name: "Palm Hills", city: "Alexandria" },
    { id: "a4", name: "Twin Park", city: "Cairo" },
    { id: "a5", name: "Twin Park", city: "Cairo" },
    { id: "a6", name: "Sheikh Zayed, West", city: "Giza" },
    { id: "a7", name: "Pine, Bay", city: "Cairo" },
    { id: "a8", name: "Pine, Bay", city: "Giza" },
    { id: "a9", name: "Pine", city: "Bay" },
  ];
  const index = buildAreaIndex(areas);
  const take = (cell: unknown, required = true) => areaCell(cell as never, index, { required });

  it("finds an area by name, ignoring case and extra spaces", () => {
    expect(take("  new   CAIRO ")).toEqual(ok("a1"));
  });

  it("two areas of one name are ambiguous unless the city is written: Name, City", () => {
    expect(take("Palm Hills")).toEqual(bad("AMBIGUOUS_REFERENCE", "import.areaAmbiguous"));
    expect(take("Palm Hills, Giza")).toEqual(ok("a2"));
    expect(take("palm hills ,  ALEXANDRIA")).toEqual(ok("a3"));
  });

  it("a name and city that two areas share is still ambiguous", () => {
    expect(take("Twin Park, Cairo")).toEqual(bad("AMBIGUOUS_REFERENCE", "import.areaAmbiguous"));
  });

  it("a name that has a comma of its own is found whole first", () => {
    expect(take("Sheikh Zayed, West")).toEqual(ok("a6"));
  });

  it("the city is what follows the last comma, so a name with a comma of its own can be followed by a city", () => {
    expect(take("Sheikh Zayed, West, Giza")).toEqual(ok("a6"));
    expect(take("Sheikh Zayed, West, Cairo")).toEqual(bad("REFERENCE_NOT_FOUND", "import.areaNotFound"));
  });

  it("a name two areas have is ambiguous even when its comma could read as Name, City", () => {
    expect(take("Pine, Bay")).toEqual(bad("AMBIGUOUS_REFERENCE", "import.areaAmbiguous"));
    expect(take("Pine, Bay, Giza")).toEqual(ok("a8"));
  });

  it("a wrong city or an unknown name is not found", () => {
    expect(take("Palm Hills, Cairo")).toEqual(bad("REFERENCE_NOT_FOUND", "import.areaNotFound"));
    expect(take("Nowhere")).toEqual(bad("REFERENCE_NOT_FOUND", "import.areaNotFound"));
    expect(take(", Cairo")).toEqual(bad("REFERENCE_NOT_FOUND", "import.areaNotFound"));
  });

  it("a number cell is not text", () => {
    expect(take(12)).toEqual(bad("NOT_TEXT", "import.cellNotText"));
  });

  it("an empty cell is required when it must be", () => {
    expect(take(null)).toEqual(bad("REQUIRED", "validation.required"));
    expect(take(null, false)).toEqual(ok(undefined));
  });

  it("an unreadable cell is reported as such", () => {
    expect(take({ unreadable: "error-value" })).toEqual(bad("UNREADABLE_CELL", "import.cellUnreadable"));
  });
});
