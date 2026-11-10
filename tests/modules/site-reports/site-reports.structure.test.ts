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
  it("mounts the site reports' router under the v1 router", () => {
    const routes = read("src/routes/index.ts");

    expect(routes).toContain('import { siteReportsRouter } from "../modules/site-reports/index.js";');
    expect(routes).toContain("v1Router.use(siteReportsRouter);");
  });

  it("serves the export from the exports router, which is mounted before the modules' routers", () => {
    const routes = read("src/routes/index.ts");
    const exportsRoutes = read("src/modules/exports/routes/exports.routes.ts");

    expect(exportsRoutes).toContain('"/site-reports/export"');
    expect(routes.indexOf("v1Router.use(exportsRouter)")).toBeLessThan(
      routes.indexOf("v1Router.use(siteReportsRouter)"),
    );
  });
});

// The villas never import the site reports, except the one count function, in a file that imports nothing but a type.
describe("the modules that count site reports do not depend on them", () => {
  const importsOf = (file: string): string[] =>
    [...read(file).matchAll(/from "([^"]*site-reports[^"]*)"/g)].map((match) => match[1]!);

  it("src/modules/villas imports only repository/site-report-rows.js from the site reports", () => {
    for (const file of sourcesUnder("src/modules/villas")) {
      for (const path of importsOf(file)) {
        expect(path, file).toMatch(/site-reports\/repository\/site-report-rows\.js$/);
      }
    }
  });

  it("site-report-rows.ts imports nothing but a type from the generated client", () => {
    const imports = [
      ...read("src/modules/site-reports/repository/site-report-rows.ts").matchAll(/^import .*$/gm),
    ].map((match) => match[0]);

    expect(imports).toEqual(['import type { Prisma } from "../../../generated/prisma/client.js";']);
  });
});

describe("the site reports module", () => {
  it("has the seven folders' files and an index", () => {
    const files = sourcesUnder("src/modules/site-reports").map((file) =>
      file.replace("src/modules/site-reports/", ""),
    );

    expect(files).toEqual(
      expect.arrayContaining([
        "index.ts",
        "controller/site-reports.controller.ts",
        "dto/site-reports.dto.ts",
        "mapper/site-reports.mapper.ts",
        "repository/site-reports.repository.ts",
        "routes/site-reports.routes.ts",
        "service/site-reports.service.ts",
        "validators/site-reports.validators.ts",
      ]),
    );
  });

  it("has no contractor or engineer anywhere: a site report is tied to a villa and its author only", () => {
    for (const file of sourcesUnder("src/modules/site-reports")) {
      const text = read(file).toLowerCase();
      expect(text, file).not.toContain("contractor");
      expect(text, file).not.toContain("engineer");
    }
  });
});
