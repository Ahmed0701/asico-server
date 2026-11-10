/// <reference types="vite/types/importMeta.d.ts" />
import { describe, expect, it, vi } from "vitest";
import { blocks, codes, doc, errorSites, hasType, jsonTree, keyTree, read, tables } from "./source.js";

// docs/frontend-contract.md is what a frontend developer builds against. It is compared with the code that decides each thing:
// the fields of every response with the DTO types, the filters of every list and the fields of every body with the zod schemas,
// the sort lists and enum values with the constants, the dashboard and audit shapes with their types, the error codes of each
// resource with the codes its module raises, and the refresh cookie with the controller.

vi.mock("../../src/core/database/prisma.js", () => ({ prisma: {} }));

const modules = import.meta.glob<Record<string, unknown>>(
  [
    "../../src/modules/*/dto/*.ts",
    "../../src/modules/*/validators/*.ts",
    "../../src/shared/constants/*.ts",
    "../../src/shared/query/*.ts",
  ],
  { eager: true },
);
const exportsByName = new Map<string, unknown>();
for (const exported of Object.values(modules)) {
  for (const [name, value] of Object.entries(exported)) exportsByName.set(name, value);
}

type Schema = { shape: Record<string, { safeParse: (value: unknown) => { success: boolean } }> };
const schemaOf = (name: string): Schema => {
  const value = exportsByName.get(name) as Schema | undefined;
  if (!value?.shape) throw new Error(`No object schema named ${name}`);
  return value;
};

const text = doc("frontend-contract.md");
const sections = tables(text);

// The lines of the document, with the marker of the section (<!-- modules: ... -->) each falls under.
const lines = text.split("\n");

describe("docs/frontend-contract.md", () => {
  it("describes every response type with exactly the fields the DTO has", () => {
    let checked = 0;
    for (const { heading, table } of sections) {
      const name = /^`([A-Za-z]+)`/.exec(heading)?.[1];
      if (table.header[0] !== "Field" || table.header[1] !== "Type" || name === undefined || !hasType(name))
        continue;
      const documented = table.rows.map((row) => /^`([^`]+)`$/.exec(row[0] ?? "")?.[1] ?? row[0] ?? "");
      expect(documented.sort(), name).toEqual(Object.keys(keyTree(name)).sort());
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("names a type that exists for every response table", () => {
    for (const { heading, table } of sections) {
      if (table.header[0] !== "Field" || table.header[1] !== "Type") continue;
      const name = /^`([A-Za-z]+)`/.exec(heading)?.[1];
      expect(name !== undefined && hasType(name), `the heading "${heading}" names no DTO type`).toBe(true);
    }
  });

  it("lists the query parameters of each list as its schema has them", () => {
    let checked = 0;
    for (const { markers, table } of sections) {
      const name = markers["query"];
      if (name === undefined) continue;
      const documented = table.rows.map((row) => /^`([^`]+)`$/.exec(row[0] ?? "")?.[1] ?? "");
      expect(documented.sort(), name).toEqual(Object.keys(schemaOf(name).shape).sort());
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("lists the fields of each request body as its schema has them, and which are required", () => {
    let checked = 0;
    for (const { markers, table } of sections) {
      const name = markers["body"];
      if (name === undefined) continue;
      const schema = schemaOf(name);
      expect(table.header.slice(0, 2), name).toEqual(["Field", "Required"]);
      const documented = new Map(
        table.rows.map((row) => [/^`([^`]+)`$/.exec(row[0] ?? "")?.[1] ?? "", (row[1] ?? "").trim()]),
      );
      expect([...documented.keys()].sort(), name).toEqual(Object.keys(schema.shape).sort());
      for (const [field, validator] of Object.entries(schema.shape)) {
        const required = !validator.safeParse(undefined).success;
        expect(documented.get(field), `${name}.${field}`).toBe(required ? "Yes" : "No");
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(15);
  });

  it("lists each set of values (sorts, statuses, types) as the code has them", () => {
    let checked = 0;
    lines.forEach((line, index) => {
      const name = /^<!--\s*list:\s*([A-Za-z_]+)\s*-->$/.exec(line.trim())?.[1];
      if (name === undefined) return;
      const next = lines.slice(index + 1).find((candidate) => candidate.trim() !== "") ?? "";
      const value = exportsByName.get(name);
      expect(Array.isArray(value), `${name} is not an exported list`).toBe(true);
      expect(codes(next), name).toEqual(value as string[]);
      checked++;
    });
    expect(checked).toBeGreaterThan(8);
  });

  it("matches the shape of the examples to their types, key for key", () => {
    let checked = 0;
    for (const { markers, body } of blocks(text, "json")) {
      const strict = markers["shape"];
      const top = markers["shape-top"];
      if (strict !== undefined) {
        expect(jsonTree(JSON.parse(body)), strict).toEqual(keyTree(strict));
        checked++;
      } else if (top !== undefined) {
        expect(Object.keys(JSON.parse(body) as object).sort(), top).toEqual(Object.keys(keyTree(top)).sort());
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("gives each resource the error codes its module raises, no more and no fewer", () => {
    // Raised by the framework for any route: described once, in the conventions.
    const everywhere = new Set(["UNAUTHORIZED", "FORBIDDEN", "BAD_REQUEST", "NOT_FOUND", "VALIDATION_ERROR"]);
    const sites = errorSites();
    let current: string[] | undefined;
    let checked = 0;
    for (const line of lines) {
      const marker = /^<!--\s*modules:\s*(.*?)\s*-->$/.exec(line.trim())?.[1];
      if (marker !== undefined) current = marker.split(",").map((name) => name.trim());
      if (!line.startsWith("**Errors:**") || current === undefined) continue;
      const documented = codes(line).sort();
      const raised = [
        ...new Set(
          sites
            .filter((site) => current!.some((name) => site.where.startsWith(`modules/${name}/`)))
            .map((site) => site.code)
            .filter((code) => !everywhere.has(code)),
        ),
      ].sort();
      expect(documented, current.join("+")).toEqual(raised);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("describes the refresh cookie as the controller sets it", () => {
    const controller = read("src/modules/auth/controller/auth.controller.ts");
    const name = /REFRESH_COOKIE = "([^"]+)"/.exec(controller)?.[1];
    const path = /REFRESH_COOKIE_PATH = "([^"]+)"/.exec(controller)?.[1];
    expect(name).toBeDefined();
    expect(path).toBeDefined();
    expect(text).toContain(`\`${name}\``);
    expect(text).toContain(`\`${path}\``);
    const rejected = [
      ...(/COOKIE_REJECTED[^[]*\[([\s\S]*?)\]/.exec(controller)?.[1] ?? "").matchAll(/"([A-Z_]+)"/g),
    ].map((match) => match[1]!);
    const line = lines.find((candidate) => candidate.startsWith("**The cookie is removed after**")) ?? "";
    expect(codes(line).sort()).toEqual(rejected.sort());
  });

  it("uses only error codes that exist", () => {
    const known = new Set([...errorSites().map((site) => site.code), "INTERNAL_ERROR"]);
    for (const line of lines.filter((candidate) => candidate.startsWith("**Errors:**"))) {
      for (const code of codes(line)) expect(known.has(code), code).toBe(true);
    }
  });

  it("links to documents that exist", () => {
    for (const [, target] of text.matchAll(/\]\(([a-z-]+\.md)(?:#[a-z-]+)?\)/g)) {
      expect(() => doc(target!), target).not.toThrow();
    }
  });
});
