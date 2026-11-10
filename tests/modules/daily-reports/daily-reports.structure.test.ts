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
  it("mounts the daily reports' router under the v1 router", () => {
    const routes = read("src/routes/index.ts");

    expect(routes).toContain('import { dailyReportsRouter } from "../modules/daily-reports/index.js";');
    expect(routes).toContain("v1Router.use(dailyReportsRouter);");
  });

  it("serves the export from the exports router, which is mounted before the modules' routers", () => {
    const routes = read("src/routes/index.ts");
    const exportsRoutes = read("src/modules/exports/routes/exports.routes.ts");

    expect(exportsRoutes).toContain('"/daily-reports/export"');
    expect(routes.indexOf("v1Router.use(exportsRouter)")).toBeLessThan(
      routes.indexOf("v1Router.use(dailyReportsRouter)"),
    );
  });
});

// A daily report belongs to a contractor, not to a villa: the villas module neither counts nor imports them.
describe("the villas do not depend on the daily reports", () => {
  it("src/modules/villas imports nothing from the daily reports", () => {
    for (const file of sourcesUnder("src/modules/villas")) {
      expect(read(file), file).not.toMatch(/from "[^"]*daily-reports[^"]*"/);
    }
  });

  it("the daily-report-rows.ts file that counted them is gone", () => {
    expect(() => read("src/modules/daily-reports/repository/daily-report-rows.ts")).toThrow();
  });
});

describe("the lock order is written down where the writers can read it", () => {
  it("names the daily reports, which take no villa row, in shared/constants/locks.ts", () => {
    const locks = read("src/shared/constants/locks.ts");

    const villa = locks.indexOf("the villa row");
    const items = locks.indexOf("the open works (FOR UPDATE");
    const reports = locks.indexOf(
      "the daily reports, the daily small works, the site reports and the daily labour (FOR UPDATE",
    );
    expect(villa).toBeGreaterThan(0);
    expect(reports).toBeGreaterThan(items);
    // A daily report belongs to a contractor and an engineer, not to a villa: it is no longer among the villa row's writers.
    expect(locks).not.toContain("daily reports' create, update and delete");
    expect(locks).toContain("A daily report belongs to no villa");
    expect(locks).toContain("the small works' create, update and delete");
    expect(locks).toContain("the site reports' create, update and delete");
  });
});

describe("the daily reports module", () => {
  it("has the seven folders' files and an index", () => {
    const files = sourcesUnder("src/modules/daily-reports").map((file) =>
      file.replace("src/modules/daily-reports/", ""),
    );

    expect(files).toEqual(
      expect.arrayContaining([
        "index.ts",
        "controller/daily-reports.controller.ts",
        "dto/daily-reports.dto.ts",
        "mapper/daily-reports.mapper.ts",
        "repository/daily-reports.repository.ts",
        "routes/daily-reports.routes.ts",
        "service/daily-reports.service.ts",
        "validators/daily-reports.validators.ts",
      ]),
    );
  });
});
