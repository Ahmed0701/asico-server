import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

function sourcesUnder(path: string): string[] {
  return readdirSync(new URL(`../../../${path}`, import.meta.url), { withFileTypes: true }).flatMap(
    (entry) =>
      entry.isDirectory()
        ? sourcesUnder(`${path}/${entry.name}`)
        : entry.name.endsWith(".ts")
          ? [`${path}/${entry.name}`]
          : [],
  );
}

describe("the composition root", () => {
  it("registers no open works hook: open works are added by hand, never by the progress or the villa", () => {
    expect(read("src/server.ts")).not.toContain("OpenWorksHooks");
    expect(
      existsSync(new URL("../../../src/modules/open-works/service/open-works-hooks.ts", import.meta.url)),
    ).toBe(false);
  });

  it("mounts the open works' router under the v1 router", () => {
    const routes = read("src/routes/index.ts");

    expect(routes).toContain('import { openWorksRouter } from "../modules/open-works/index.js";');
    expect(routes).toContain("v1Router.use(openWorksRouter);");
  });
});

// The villas, the villa progress and the elec phases never import the open works, so there is no cycle: the open works
// register themselves on their hooks. The one exception is the two count functions, in a file that imports nothing.
describe("the modules that the open works hook into do not depend on them", () => {
  const OTHER = ["src/modules/villas", "src/modules/villa-progress", "src/modules/elec-phases"];
  const importsOf = (file: string): string[] =>
    [...read(file).matchAll(/from "([^"]*open-works[^"]*)"/g)].map((match) => match[1]!);

  it.each(OTHER)("%s imports only repository/work-item-rows.js from the open works", (dir) => {
    for (const file of sourcesUnder(dir)) {
      for (const path of importsOf(file)) {
        expect(path, file).toMatch(/open-works\/repository\/work-item-rows\.js$/);
      }
    }
  });

  it("work-item-rows.ts imports nothing but a type from the generated client", () => {
    const imports = [
      ...read("src/modules/open-works/repository/work-item-rows.ts").matchAll(/^import .*$/gm),
    ].map((match) => match[0]);

    expect(imports).toEqual(['import type { Prisma } from "../../../generated/prisma/client.js";']);
  });

  it("the hook lists are declared in the modules that run them, not in the open works", () => {
    expect(read("src/modules/villas/service/villa-hooks.ts")).toContain("export const contractorChangeHooks");
    expect(read("src/modules/villa-progress/service/villa-progress.service.ts")).toContain(
      "export const progressChangeHooks",
    );
  });
});

describe("the lock order is written down where the writers can read it", () => {
  it("names the locks in order in shared/constants/locks.ts", () => {
    const locks = read("src/shared/constants/locks.ts");

    const villa = locks.indexOf("the villa row");
    const phase = locks.indexOf("the elec phase row");
    const progress = locks.indexOf("the villa's progress rows");
    const items = locks.indexOf("the open works (FOR UPDATE");
    expect(villa).toBeGreaterThan(0);
    expect(phase).toBeGreaterThan(villa);
    expect(progress).toBeGreaterThan(phase);
    expect(items).toBeGreaterThan(progress);
  });
});
