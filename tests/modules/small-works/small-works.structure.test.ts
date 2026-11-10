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
  it("mounts the small works' router under the v1 router", () => {
    const routes = read("src/routes/index.ts");

    expect(routes).toContain('import { smallWorksRouter } from "../modules/small-works/index.js";');
    expect(routes).toContain("v1Router.use(smallWorksRouter);");
  });

  it("serves the export from the exports router, which is mounted before the modules' routers", () => {
    const routes = read("src/routes/index.ts");
    const exportsRoutes = read("src/modules/exports/routes/exports.routes.ts");

    expect(exportsRoutes).toContain('"/small-works/export"');
    expect(routes.indexOf("v1Router.use(exportsRouter)")).toBeLessThan(
      routes.indexOf("v1Router.use(smallWorksRouter)"),
    );
  });
});

// The villas never import the small works, except the one count function, in a file that imports nothing but a type.
describe("the modules that count small works do not depend on them", () => {
  const importsOf = (file: string): string[] =>
    [...read(file).matchAll(/from "([^"]*small-works[^"]*)"/g)].map((match) => match[1]!);

  it("src/modules/villas imports only repository/small-work-rows.js from the small works", () => {
    for (const file of sourcesUnder("src/modules/villas")) {
      for (const path of importsOf(file)) {
        expect(path, file).toMatch(/small-works\/repository\/small-work-rows\.js$/);
      }
    }
  });

  it("small-work-rows.ts imports nothing but a type from the generated client", () => {
    const imports = [
      ...read("src/modules/small-works/repository/small-work-rows.ts").matchAll(/^import .*$/gm),
    ].map((match) => match[0]);

    expect(imports).toEqual(['import type { Prisma } from "../../../generated/prisma/client.js";']);
  });
});

describe("the small works module", () => {
  it("has the seven folders' files and an index", () => {
    const files = sourcesUnder("src/modules/small-works").map((file) =>
      file.replace("src/modules/small-works/", ""),
    );

    expect(files).toEqual(
      expect.arrayContaining([
        "index.ts",
        "controller/small-works.controller.ts",
        "dto/small-works.dto.ts",
        "mapper/small-works.mapper.ts",
        "repository/small-works.repository.ts",
        "routes/small-works.routes.ts",
        "service/small-works.service.ts",
        "validators/small-works.validators.ts",
      ]),
    );
  });

  it("holds its contractor by id only: it never imports the contractors module", () => {
    for (const file of sourcesUnder("src/modules/small-works")) {
      expect(read(file), file).not.toMatch(/from "[^"]*(modules|\.\.)\/contractors\//);
    }
  });

  it("has a contractor that is required and a pair of days: no doneBy and no workDate are left", () => {
    const dto = read("src/modules/small-works/dto/small-works.dto.ts");
    const schema = read("src/modules/small-works/validators/small-works.validators.ts");

    expect(dto).toContain("contractor: { id: string; name: string };");
    expect(schema).toMatch(/createSmallWorkSchema[\s\S]*contractorId: id,/);
    for (const file of sourcesUnder("src/modules/small-works")) {
      expect(read(file), file).not.toMatch(/doneBy|workDate/);
    }
  });
});
