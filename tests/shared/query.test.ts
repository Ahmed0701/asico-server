import { describe, expect, it } from "vitest";
import { parseSort } from "../../src/shared/query/sort.js";
import { escapeLike } from "../../src/shared/query/where.js";

describe("parseSort", () => {
  it("only accepts allowlisted fields", () => {
    expect(parseSort("name:desc", ["name"])).toEqual({ field: "name", direction: "desc" });
    expect(parseSort("password", ["name"])).toBeUndefined();
    expect(parseSort("name", [])).toBeUndefined();
  });
});

describe("escapeLike", () => {
  it("escapes the LIKE wildcards and the escape character, and leaves other text alone", () => {
    const backslash = String.fromCharCode(92);
    expect(escapeLike("100%")).toBe(`100${backslash}%`);
    expect(escapeLike("a_b")).toBe(`a${backslash}_b`);
    expect(escapeLike(`back${backslash}slash`)).toBe(`back${backslash}${backslash}slash`);
    expect(escapeLike("plain text @ example.com")).toBe("plain text @ example.com");
    expect(escapeLike(`%_${backslash}`)).toBe(`${backslash}%${backslash}_${backslash}${backslash}`);
  });
});
