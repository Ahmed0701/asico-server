import { describe, expect, it } from "vitest";
import { z } from "zod";
import { PARTY_STATUSES } from "../../src/shared/constants/enums.js";
import { contactEmail, hasAnyField, partyStatus } from "../../src/shared/validation/fields.js";

// The optional email and the ACTIVE/INACTIVE status shared by civil engineers, electrical engineers and contractors.

const body = z.strictObject({ email: contactEmail.optional() });
const parse = (email?: unknown) => body.safeParse(email === undefined ? {} : { email });
const issues = (result: z.ZodSafeParseResult<unknown>) =>
  result.success ? [] : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

describe("contactEmail", () => {
  it("leaves an absent email absent, so an update that does not mention it does not touch it", () => {
    const result = parse();

    expect(result.success && "email" in result.data).toBe(false);
  });

  it.each([
    ["mona@example.test", "mona@example.test"],
    ["  mona@example.test  ", "mona@example.test"],
    ["Mona.Hassan@Example.TEST", "mona.hassan@example.test"],
    ["MONA+site@Sub.Example.Co.UK", "mona+site@sub.example.co.uk"],
    ["a@b.co", "a@b.co"],
    ["first_last-name@my-company.example", "first_last-name@my-company.example"],
  ])("accepts %j and stores %j", (input, stored) => {
    const result = parse(input);

    expect(result.success && result.data.email).toBe(stored);
  });

  it.each([null, "", " ", "   ", "\t", "\n "])("reads %j as no email (null)", (input) => {
    const result = parse(input);

    expect(result.success && result.data.email).toBeNull();
  });

  it.each([
    "mona",
    "mona@",
    "@example.test",
    "mona@example",
    "mona@@example.test",
    "mona example@example.test",
    "mona@exa mple.test",
    "mona@example..test",
    ".mona@example.test",
    "mona.@example.test",
    "mona@-example.test",
    "mailto:mona@example.test",
    "<mona@example.test>",
    "mona@example.test, other@example.test",
  ])("rejects %j with one emailInvalid error", (input) => {
    expect(issues(parse(input))).toEqual([{ path: "email", message: "validation.emailInvalid" }]);
  });

  it.each([12, true, {}, [], ["a@b.test"]])("rejects %j, which is not text, as required", (input) => {
    expect(issues(parse(input))).toEqual([{ path: "email", message: "validation.required" }]);
  });

  it("accepts an address of exactly 254 characters and rejects 255, with the length message", () => {
    // 64 characters is the longest local part, so the length comes from the domain.
    const longDomain = `${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(55)}.test`;
    const address = (length: number) => `${"l".repeat(64)}@${longDomain.slice(0, length - 65)}`;

    expect(address(254)).toHaveLength(254);
    expect(parse(address(254)).success).toBe(true);
    expect(issues(parse(address(255)))).toEqual([{ path: "email", message: "validation.emailTooLong" }]);
  });

  it("trims before it measures, so spaces around a 254-character address do not count", () => {
    const longDomain = `${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(55)}.test`;
    const address = `${"l".repeat(64)}@${longDomain.slice(0, 254 - 65)}`;

    expect(parse(`   ${address}   `).success).toBe(true);
  });
});

describe("partyStatus", () => {
  it("is ACTIVE or INACTIVE", () => {
    expect([...PARTY_STATUSES]).toEqual(["ACTIVE", "INACTIVE"]);
    expect(partyStatus.safeParse("ACTIVE").success).toBe(true);
    expect(partyStatus.safeParse("INACTIVE").success).toBe(true);
  });

  it.each(["active", "Inactive", "PAUSED", "OPEN", "", " ACTIVE", null, undefined, 1, true])(
    "rejects %j with the partyStatusInvalid message",
    (value) => {
      const result = partyStatus.safeParse(value);

      expect(result.success).toBe(false);
      expect(!result.success && result.error.issues.map((i) => i.message)).toEqual([
        "validation.partyStatusInvalid",
      ]);
    },
  );
});

describe("hasAnyField", () => {
  it("is false for an empty body and for a body of undefined values", () => {
    expect(hasAnyField({})).toBe(false);
    expect(hasAnyField({ a: undefined, b: undefined })).toBe(false);
  });

  it("is true when any field is present, and a null counts: it clears the value", () => {
    expect(hasAnyField({ a: 1 })).toBe(true);
    expect(hasAnyField({ a: undefined, b: "x" })).toBe(true);
    expect(hasAnyField({ email: null })).toBe(true);
    expect(hasAnyField({ email: "" })).toBe(true);
    expect(hasAnyField({ flag: false })).toBe(true);
    expect(hasAnyField({ count: 0 })).toBe(true);
  });
});
