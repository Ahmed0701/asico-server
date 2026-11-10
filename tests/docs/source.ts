import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// What the documentation tests read: the documents themselves, and the source they describe.

export const ROOT = join(import.meta.dirname, "..", "..");
export const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");
export const doc = (name: string): string => read(`docs/${name}`);

export function files(directory: string, extension: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = join(directory, entry);
    if (statSync(join(ROOT, path)).isDirectory()) out.push(...files(path, extension));
    else if (path.endsWith(extension)) out.push(path.split("\\").join("/"));
  }
  return out;
}

// ---- Markdown ----

export type Table = { header: string[]; rows: string[][] };

const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));

// Every pipe table of the document, in order, with the heading text it sits under and any <!-- key: value --> markers
// found between that heading and the table.
export type Section = { heading: string; markers: Record<string, string>; table: Table };

export function tables(markdown: string): Section[] {
  const lines = markdown.split("\n");
  const found: Section[] = [];
  let heading = "";
  let markers: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const title = /^#{1,6}\s+(.*)$/.exec(line);
    if (title) {
      heading = title[1]!.trim();
      markers = {};
      continue;
    }
    const marker = /^<!--\s*([a-z-]+):\s*(.*?)\s*-->$/.exec(line.trim());
    if (marker) {
      markers[marker[1]!] = marker[2]!;
      continue;
    }
    if (line.trim().startsWith("|") && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? "")) {
      const header = cellsOf(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(cellsOf(lines[i]!));
        i++;
      }
      i--;
      found.push({ heading, markers: { ...markers }, table: { header, rows } });
      markers = {};
    }
  }
  return found;
}

// The text inside backticks, or the cell as it is.
export const code = (cell: string): string => /^`([^`]*)`$/.exec(cell.trim())?.[1] ?? cell.trim();
export const codes = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);

// The fenced blocks of a language, each with the markers (<!-- key: value -->) written just before it.
export function blocks(
  markdown: string,
  language: string,
): { markers: Record<string, string>; body: string }[] {
  const found: { markers: Record<string, string>; body: string }[] = [];
  const lines = markdown.split("\n");
  let markers: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const marker = /^<!--\s*([a-z-]+):\s*(.*?)\s*-->$/.exec(line.trim());
    if (marker) {
      markers[marker[1]!] = marker[2]!;
      continue;
    }
    if (line.trim() === `\`\`\`${language}`) {
      const start = i + 1;
      while (i + 1 < lines.length && lines[i + 1]!.trim() !== "```") i++;
      found.push({ markers, body: lines.slice(start, i + 1).join("\n") });
      i++;
    }
    if (line.trim() !== "" && !line.startsWith("```")) markers = {};
  }
  return found;
}

// ---- Types ----

// The properties of a type alias declared in a module's dto files, as a tree: a nested object type, an array of one, or a
// type that is one or the other and null, is followed; anything else is a leaf (null).
export type KeyTree = { [key: string]: KeyTree | null };

type Declarations = Map<string, { file: ts.SourceFile; node: ts.TypeAliasDeclaration }>;

let declarations: Declarations | undefined;
function declared(): Declarations {
  if (declarations) return declarations;
  declarations = new Map();
  const dtoFiles = files("src/modules", ".ts").filter((file) => /\/dto\/[^/]+\.ts$/.test(file));
  // The few shapes that are shared: the page meta, an import report, the detail of an error.
  const shared = [
    "src/shared/query/pagination.ts",
    "src/shared/import/types.ts",
    "src/core/errors/AppError.ts",
  ];
  for (const path of [...dtoFiles, ...shared]) {
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
    source.forEachChild((node) => {
      if (ts.isTypeAliasDeclaration(node)) declarations!.set(node.name.text, { file: source, node });
    });
  }
  return declarations;
}

const nameOf = (name: ts.PropertyName): string =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText();

function treeOf(node: ts.TypeNode): KeyTree | null | "unknown" {
  if (ts.isParenthesizedTypeNode(node)) return treeOf(node.type);
  if (ts.isTypeLiteralNode(node)) {
    const tree: KeyTree = {};
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type) continue;
      const inner = treeOf(member.type);
      tree[nameOf(member.name)] = inner === "unknown" ? null : inner;
    }
    return tree;
  }
  if (ts.isArrayTypeNode(node)) return treeOf(node.elementType);
  if (ts.isUnionTypeNode(node)) {
    const shapes = node.types
      .filter(
        (part) =>
          part.kind !== ts.SyntaxKind.NullKeyword &&
          !(ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword),
      )
      .map(treeOf)
      .filter((shape): shape is KeyTree => typeof shape === "object" && shape !== null);
    return shapes[0] ?? null;
  }
  if (ts.isIntersectionTypeNode(node)) {
    const merged: KeyTree = {};
    for (const part of node.types) {
      const shape = treeOf(part);
      if (typeof shape === "object" && shape !== null) Object.assign(merged, shape);
    }
    return merged;
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (name === "Omit" && node.typeArguments?.length === 2) {
      const base = treeOf(node.typeArguments[0]!);
      const removed = new Set(
        ts.isUnionTypeNode(node.typeArguments[1]!)
          ? node.typeArguments[1]!.types.map((part) =>
              ts.isLiteralTypeNode(part) ? (part.literal as ts.StringLiteral).text : "",
            )
          : [
              ts.isLiteralTypeNode(node.typeArguments[1]!)
                ? (node.typeArguments[1]!.literal as ts.StringLiteral).text
                : "",
            ],
      );
      if (typeof base === "object" && base !== null) {
        return Object.fromEntries(Object.entries(base).filter(([key]) => !removed.has(key)));
      }
      return null;
    }
    if (name === "Array" || name === "ReadonlyArray") {
      return node.typeArguments?.[0] ? treeOf(node.typeArguments[0]) : null;
    }
    const target = declared().get(name);
    if (target) return treeOf(target.node.type);
    return null;
  }
  return null;
}

// The property tree of an exported type alias of the dto files.
export function keyTree(typeName: string): KeyTree {
  const target = declared().get(typeName);
  if (!target) throw new Error(`No type ${typeName} in a dto file`);
  const tree = treeOf(target.node.type);
  if (typeof tree !== "object" || tree === null) throw new Error(`${typeName} is not an object type`);
  return tree;
}

export const hasType = (typeName: string): boolean => declared().has(typeName);

// The tree of a JSON value in the same shape: an array is described by its first element, null and scalars are leaves.
export function jsonTree(value: unknown): KeyTree | null {
  if (Array.isArray(value)) return jsonTree(value[0]);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, jsonTree(inner)]));
  }
  return null;
}

// ---- Constants and codes ----

// The string members of `export const NAME = [...] as const` in a file.
export function constantList(path: string, name: string): string[] {
  const text = read(path);
  const match = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(text);
  if (!match) throw new Error(`No list ${name} in ${path}`);
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((item) => item[1]!);
}

export type ErrorSite = { status: number; code: string; where: string };

// Every `<status>, ..., "CODE"` in the source, the first code after the status: new AppError(status, message, "CODE"),
// fail(ctx, status, key, "CODE") and new ImportFileError(status, "CODE", key).
export function errorSites(): ErrorSite[] {
  const pattern =
    /\b([1-5]\d\d)\s*,\s*(?:(?:(?!"[A-Z][A-Z0-9_]{5,}")[^;]){0,160}?,\s*)?"([A-Z][A-Z0-9_]{5,})"/g;
  const sites: ErrorSite[] = [];
  for (const path of files("src", ".ts")) {
    const text = read(path);
    for (const match of text.matchAll(pattern)) {
      sites.push({
        status: Number(match[1]),
        code: match[2]!,
        where: relative("src", path).split("\\").join("/"),
      });
    }
  }
  return sites;
}
