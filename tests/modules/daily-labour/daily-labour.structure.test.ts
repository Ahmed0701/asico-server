import { readFileSync, readdirSync } from "node:fs";
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
  it("mounts the daily labour's router under the v1 router", () => {
    const routes = read("src/routes/index.ts");

    expect(routes).toContain('import { dailyLabourRouter } from "../modules/daily-labour/index.js";');
    expect(routes).toContain("v1Router.use(dailyLabourRouter);");
  });

  it("serves the export from the exports router, which is mounted before the modules' routers", () => {
    const routes = read("src/routes/index.ts");
    const exportsRoutes = read("src/modules/exports/routes/exports.routes.ts");

    expect(exportsRoutes).toContain('"/daily-labour/export"');
    expect(routes.indexOf("v1Router.use(exportsRouter)")).toBeLessThan(
      routes.indexOf("v1Router.use(dailyLabourRouter)"),
    );
  });
});

// The villas never import the daily labour, except the one count function, in a file that imports nothing but a type.
describe("the modules that count daily labour do not depend on it", () => {
  const importsOf = (file: string): string[] =>
    [...read(file).matchAll(/from "([^"]*daily-labour[^"]*)"/g)].map((match) => match[1]!);

  it("src/modules/villas imports only repository/daily-labour-rows.js from the daily labour", () => {
    for (const file of sourcesUnder("src/modules/villas")) {
      for (const path of importsOf(file)) {
        expect(path, file).toMatch(/daily-labour\/repository\/daily-labour-rows\.js$/);
      }
    }
  });

  it("the contractors module does not import the daily labour at all: its foreign key is the guard", () => {
    for (const file of sourcesUnder("src/modules/contractors")) {
      expect(importsOf(file), file).toEqual([]);
    }
  });

  it("daily-labour-rows.ts imports nothing but a type from the generated client", () => {
    const imports = [
      ...read("src/modules/daily-labour/repository/daily-labour-rows.ts").matchAll(/^import .*$/gm),
    ].map((match) => match[0]);

    expect(imports).toEqual(['import type { Prisma } from "../../../generated/prisma/client.js";']);
  });
});

describe("the lock order is written down where the writers can read it", () => {
  it("names the daily labour after the villa row in shared/constants/locks.ts", () => {
    const locks = read("src/shared/constants/locks.ts");

    const villa = locks.indexOf("the villa row");
    const items = locks.indexOf("the open works (FOR UPDATE");
    const rows = locks.indexOf(
      "the daily reports, the daily small works, the site reports and the daily labour (FOR UPDATE",
    );
    expect(villa).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(items);
    expect(locks).toContain("and the daily labour's create, update and delete");
    expect(locks).toContain("The daily labour: the villa row FOR SHARE (2), then the row (6)");
  });
});

describe("the daily labour module", () => {
  it("has the seven folders' files and an index", () => {
    const files = sourcesUnder("src/modules/daily-labour").map((file) =>
      file.replace("src/modules/daily-labour/", ""),
    );

    expect(files).toEqual(
      expect.arrayContaining([
        "index.ts",
        "controller/daily-labour.controller.ts",
        "dto/daily-labour.dto.ts",
        "mapper/daily-labour.mapper.ts",
        "repository/daily-labour.repository.ts",
        "routes/daily-labour.routes.ts",
        "service/daily-labour.service.ts",
        "validators/daily-labour.validators.ts",
      ]),
    );
  });
});
