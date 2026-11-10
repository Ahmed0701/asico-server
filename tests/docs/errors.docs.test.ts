import { describe, expect, it } from "vitest";
import { codes, doc, errorSites, read, tables } from "./source.js";

// docs/errors.md lists every error code the application raises, with the status it answers: a code that is raised and not listed,
// listed and not raised, or listed under another status, fails here.

// The one code that is not raised at a call site: the error handler's answer to anything unexpected.
const FALLBACK = { INTERNAL_ERROR: [500] };

function documented(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const { table } of tables(doc("errors.md"))) {
    if (table.header[0] !== "Code") continue;
    for (const row of table.rows) {
      const [code] = codes(row[0] ?? "");
      if (!code) continue;
      found.set(code, [...(found.get(code) ?? []), Number(row[1])]);
    }
  }
  return found;
}

function raised(): Map<string, number[]> {
  const found = new Map<string, Set<number>>();
  for (const { code, status } of errorSites()) {
    found.set(code, (found.get(code) ?? new Set()).add(status));
  }
  return new Map([...found].map(([code, statuses]) => [code, [...statuses].sort()]));
}

describe("docs/errors.md", () => {
  const docs = documented();
  const source = raised();

  it("lists every code the source raises", () => {
    const missing = [...source.keys()].filter((code) => !docs.has(code));
    expect(missing).toEqual([]);
  });

  it("lists nothing the source does not raise", () => {
    const extra = [...docs.keys()].filter((code) => !source.has(code) && !(code in FALLBACK));
    expect(extra).toEqual([]);
  });

  it("gives each code once, under the status the source answers it with", () => {
    for (const [code, statuses] of docs) {
      expect(statuses, `${code} is listed more than once`).toHaveLength(1);
      const expected = source.get(code) ?? FALLBACK[code as keyof typeof FALLBACK];
      expect(expected, `${code} status`).toContain(statuses[0]);
      // A code raised with two statuses would have to be listed twice.
      expect(expected, `${code} is raised with more than one status`).toHaveLength(1);
    }
  });

  it("names the fallback where the error handler has it", () => {
    expect(read("src/core/errors/errorHandler.ts")).toContain('"INTERNAL_ERROR"');
  });

  it("links to documents that exist", () => {
    for (const [, target] of doc("errors.md").matchAll(/\]\(([a-z-]+\.md)(?:#[a-z-]+)?\)/g)) {
      expect(() => doc(target!), target).not.toThrow();
    }
  });
});
