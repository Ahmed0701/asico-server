import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { read, ROOT } from "./source.js";

// The README is the index of the documents: it links every one, every link goes somewhere, and the commands it names exist.

const readme = read("README.md");
const docsFolder = join(ROOT, "docs");
const documents = readdirSync(docsFolder).filter((name) => name.endsWith(".md"));
const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string>; description: string })
  .scripts;

describe("README.md", () => {
  it("links every document in docs/", () => {
    expect(documents.length).toBeGreaterThanOrEqual(8);
    expect(documents.filter((name) => !readme.includes(`(docs/${name})`))).toEqual([]);
  });

  it("links only to files that exist", () => {
    for (const [, target] of readme.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
      if (/^https?:/.test(target!)) continue;
      expect(existsSync(join(ROOT, target!)), target).toBe(true);
    }
  });

  it("names only npm scripts that exist", () => {
    for (const [, name] of readme.matchAll(/npm run ([a-z:-]+)/g)) {
      expect(scripts, name).toHaveProperty(name!);
    }
  });
});

describe("the documents", () => {
  it.each(documents)("%s links only to files and headings that exist", (name) => {
    const text = read(`docs/${name}`);
    for (const [, target, heading] of text.matchAll(/\]\(([^)#\s]+)(?:#([^)]*))?\)/g)) {
      if (/^https?:/.test(target!)) continue;
      const path = join(docsFolder, target!);
      expect(existsSync(path), `${name} -> ${target}`).toBe(true);
      if (heading !== undefined && target!.endsWith(".md")) {
        const slugs = [...read(`docs/${target}`).matchAll(/^#{1,6}\s+(.*)$/gm)].map((match) =>
          match[1]!
            .toLowerCase()
            .replace(/[^a-z0-9 -]/g, "")
            .trim()
            .replace(/ /g, "-"),
        );
        expect(slugs, `${name} -> ${target}#${heading}`).toContain(heading);
      }
    }
  });
});

describe("package.json", () => {
  it("describes the system as what it is: villas, not projects", () => {
    const { description } = JSON.parse(read("package.json")) as { description: string };
    expect(description).not.toMatch(/project/i);
    expect(description).toMatch(/villa/i);
  });
});
