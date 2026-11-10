import { describe, expect, it } from "vitest";
import { listAuditLogsQuerySchema } from "../../../src/modules/audit/index.js";
import {
  contractorSummaryQuerySchema,
  listContractorsQuerySchema,
} from "../../../src/modules/contractors/index.js";
import { appliedFilters, describeFilters } from "../../../src/modules/exports/service/filters.js";
import { exportQuery } from "../../../src/modules/exports/validators/exports.validators.js";
import { listVillasQuerySchema } from "../../../src/modules/villas/index.js";

const villas = exportQuery(listVillasQuerySchema);
const issues = (schema: ReturnType<typeof exportQuery>, input: Record<string, unknown>) => {
  const result = schema.safeParse(input);
  return result.success ? null : result.error.issues.map((i) => [i.path.join("."), i.message]);
};

describe("exportQuery", () => {
  it.each(["xlsx", "pdf"])("accepts format=%s", (format) => {
    expect(villas.parse({ format })).toMatchObject({ format });
  });

  it.each([[undefined], [""], ["csv"], ["XLSX"], ["PDF"], [["xlsx", "pdf"]], [1], [null]])(
    "rejects format=%j",
    (format) => {
      expect(issues(villas, { format })).toEqual([["format", "validation.formatInvalid"]]);
    },
  );

  it("rejects a request with no format at all", () => {
    expect(issues(villas, {})).toEqual([["format", "validation.formatInvalid"]]);
  });

  it.each(["page", "limit"])("rejects %s, whatever its value", (key) => {
    for (const value of ["1", "5", "1000", "", "abc", 0]) {
      expect(issues(villas, { format: "xlsx", [key]: value }), `${key}=${String(value)}`).toEqual([
        [key, "validation.paginationNotAllowed"],
      ]);
    }
  });

  it("reports the format, paging and filter problems together", () => {
    const found = issues(villas, { format: "csv", page: "1", limit: "2", contractorId: "nope" }) ?? [];

    expect(found.map(([path]) => path).sort()).toEqual(["contractorId", "format", "limit", "page"]);
  });

  it("returns what the list schema returns, with the first page at the biggest size", () => {
    const parsed = villas.parse({ format: "pdf", block: "B1", search: "  cairo  ", sort: "location:desc" });

    expect(parsed.format).toBe("pdf");
    expect(parsed.query).toEqual(
      listVillasQuerySchema.parse({
        block: "B1",
        search: "  cairo  ",
        sort: "location:desc",
        page: "1",
        limit: "1000",
      }),
    );
    expect(parsed.query).toMatchObject({ page: 1, limit: 1000, block: "B1", search: "cairo" });
  });

  it("the filters are the list schema's own: calendar days become Dates", () => {
    const { query } = villas.parse({
      format: "xlsx",
      startFrom: "2026-01-01",
      startTo: "2026-01-31",
    });

    expect(query.startFrom).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(query.startTo).toEqual(new Date("2026-01-31T00:00:00.000Z"));
  });

  it("gives the list schema's errors with the list schema's messages and paths", () => {
    expect(issues(villas, { format: "xlsx", contractorId: "nope" })).toEqual(
      issues(listVillasQuerySchema as never, { contractorId: "nope", page: "1", limit: "1000" }),
    );
    expect(issues(villas, { format: "xlsx", startFrom: "2026-02-01", startTo: "2026-01-01" })).toEqual([
      ["startTo", "validation.dateRangeInvalid"],
    ]);
    expect(issues(villas, { format: "xlsx", sort: "bogus" })).toEqual([
      ["sort", "validation.sortVillasInvalid"],
    ]);
  });

  it("ignores parameters the list ignores", () => {
    expect(villas.parse({ format: "xlsx", whatever: "1" }).query).not.toHaveProperty("whatever");
  });

  it("works for the other lists: contractors, summary, audit", () => {
    expect(
      exportQuery(listContractorsQuerySchema).parse({ format: "pdf", sort: "name:desc" }).query,
    ).toMatchObject({ sort: "name:desc" });
    expect(
      exportQuery(contractorSummaryQuerySchema).parse({ format: "pdf", sort: "startDate:desc" }).query,
    ).toMatchObject({ sort: "startDate:desc" });
    expect(
      exportQuery(listAuditLogsQuerySchema).parse({ format: "pdf", entity: "Villa" }).query,
    ).toMatchObject({ entity: "Villa" });
    expect(
      issues(exportQuery(listAuditLogsQuerySchema), { format: "pdf", from: "2026-02-01", to: "2026-01-01" }),
    ).toEqual([["to", "validation.dateRangeInvalid"]]);
  });
});

describe("describeFilters", () => {
  it("writes one Label: value line per filter, in the order given", () => {
    expect(describeFilters({ area: "New Cairo", block: "B1", plot: "007", search: "nile" })).toEqual([
      "Area: New Cairo",
      "Block: B1",
      "Plot: 007",
      "Search: nile",
    ]);
  });

  it("skips paging and anything unset", () => {
    expect(describeFilters({ page: 1, limit: 1000, status: undefined, area: "", search: null })).toEqual([]);
  });

  it("writes booleans as Yes and No", () => {
    expect(describeFilters({ flagged: true, archived: false })).toEqual(["flagged: Yes", "archived: No"]);
  });

  it("shows a date that is a whole day as a date, and an exact time as a timestamp", () => {
    expect(
      describeFilters({
        startFrom: new Date("2026-01-01T00:00:00.000Z"),
        startTo: new Date("2026-01-31T23:59:59.999Z"),
        from: new Date("2026-03-04T05:06:00.000Z"),
      }),
    ).toEqual(["Start from: 2026-01-01", "Start to: 2026-01-31", "From: 2026-03-04 05:06 UTC"]);
  });

  it("shows the sort in words and ids as they are", () => {
    expect(
      describeFilters({ sort: "villaNumber:desc", civilEngineerId: "abc", contractorId: "def" }),
    ).toEqual(["Civil engineer ID: abc", "Contractor ID: def", "Sort: villaNumber desc"]);
  });

  it("describes a party status filter in words", () => {
    expect(describeFilters({ status: "INACTIVE", search: "x" })).toEqual(["Status: Inactive", "Search: x"]);
  });

  it.each([
    [{ status: "NOT_STARTED" }, "Status: Not started"],
    [{ status: "IN_PROGRESS" }, "Status: In progress"],
    [{ status: "DELAYED" }, "Status: Delayed"],
    [{ status: "DONE" }, "Status: Done"],
    [{ status: "ACTIVE" }, "Status: Active"],
    [{ priority: "HIGH" }, "Priority: High"],
    [{ overdue: true }, "Overdue: Yes"],
    [{ overdue: false }, "Overdue: No"],
    [{ villaId: "v-1" }, "Villa ID: v-1"],
    [{ elecPhaseId: "p-1" }, "Electrical phase ID: p-1"],
    [{ endFrom: new Date("2026-02-01T00:00:00.000Z") }, "End from: 2026-02-01"],
    [{ endTo: new Date("2026-02-28T23:59:59.999Z") }, "End to: 2026-02-28"],
  ])("describes the open works filter %j as %s", (filters, line) => {
    expect(describeFilters(filters)).toEqual([line]);
  });

  it("leaves a code it has no word for as it is, and never reads a code off the object's prototype", () => {
    expect(describeFilters({ priority: "URGENT" })).toEqual(["Priority: URGENT"]);
    expect(describeFilters({ status: "constructor" })).toEqual(["Status: constructor"]);
    expect(describeFilters({ priority: "__proto__" })).toEqual(["Priority: __proto__"]);
  });

  it("only turns a code into words under the filter it belongs to", () => {
    expect(describeFilters({ search: "DONE", area: "MEP" })).toEqual(["Area: MEP", "Search: DONE"]);
  });

  it("keeps Arabic search text", () => {
    expect(describeFilters({ search: "القاهرة" })).toEqual(["Search: القاهرة"]);
  });

  it("falls back to the key for a filter it has no label for", () => {
    expect(describeFilters({ mystery: "x" })).toEqual(["mystery: x"]);
  });
});

describe("appliedFilters", () => {
  it("drops paging and unset values and keeps the rest as they are", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");

    expect(
      appliedFilters({
        page: 1,
        limit: 1000,
        status: "ACTIVE",
        area: undefined,
        search: "",
        flag: false,
        date,
      }),
    ).toEqual({
      status: "ACTIVE",
      flag: false,
      date,
    });
  });
});
