import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildTemplate,
  IMPORT_MAX_LIST_VALUES,
  IMPORT_MAX_ROWS,
  matchHeader,
  readXlsx,
  type ImportColumn,
  type TemplateSpec,
} from "../../../src/shared/import/index.js";
import { xmlOf } from "./xlsx-fixtures.js";

const columns: ImportColumn[] = [
  { header: "name", kind: "text", required: true, description: "The name.", example: "Example Co." },
  { header: "phone", kind: "text", required: true, description: "The phone.", example: "0100 123 4567" },
  {
    header: "status",
    kind: "text",
    required: false,
    description: "Leave empty for Active.",
    example: "Active",
    values: ["Active", "Inactive"],
  },
  { header: "area", kind: "text", required: true, description: "The area.", example: "New Cairo" },
];
const base: TemplateSpec = { sheetName: "Contractors", plural: "contractors", columns };
const LAST_ROW = IMPORT_MAX_ROWS + 1;
// Half of a character outside the BMP (an emoji cut in two), which is not valid in XML.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

async function loaded(bytes: Buffer): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  return workbook;
}
const rulesOf = (xml: string): string[] =>
  [...xml.matchAll(/<dataValidation [^>]*sqref="([^"]+)"/g)].map((match) => match[1]!);
const dataXml = (bytes: Buffer): string => xmlOf(bytes, "xl/worksheets/sheet1.xml");
const instructionsOf = (workbook: ExcelJS.Workbook): string[] => {
  const text: string[] = [];
  workbook.getWorksheet("Instructions")!.eachRow((row) => text.push(row.getCell(3).text));
  return text;
};

describe("buildTemplate: the dropdown rules", () => {
  it("writes one rule per dropdown column, over the rows the importer reads, and none that overlap", async () => {
    const rules = rulesOf(dataXml(await buildTemplate({ ...base, lists: { area: ["Maadi"] } })));

    expect(rules).toEqual([`C2:C${LAST_ROW}`, `D2:D${LAST_ROW}`]);
  });

  it("gives every dropdown a prompt and a stop-style error, titled by the column", async () => {
    const sheet = (
      await loaded(await buildTemplate({ ...base, lists: { area: ["Maadi", "Zamalek"] } }))
    ).getWorksheet("Contractors")!;

    expect(sheet.getCell("C2").dataValidation).toMatchObject({
      allowBlank: true,
      showInputMessage: true,
      promptTitle: "status",
      prompt: "Pick one from the list, or leave it empty.",
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: "status",
      error: "Choose one of: Active, Inactive",
    });
    expect(sheet.getCell(LAST_ROW, 4).dataValidation).toMatchObject({
      formulae: ["Lists!$D$1:$D$2"],
      promptTitle: "area",
      prompt: "Pick one from the list.",
      error: "Choose one of: Maadi, Zamalek",
    });
    expect(sheet.getCell(LAST_ROW, 4).dataValidation.allowBlank).toBeFalsy();
    expect(sheet.getCell(LAST_ROW + 1, 4).dataValidation).toBeFalsy();
  });

  it("takes the choices of a column from `lists`, and keeps them out of the instructions", async () => {
    const plain: ImportColumn = {
      header: "area",
      kind: "text",
      required: true,
      description: "The area.",
      example: "",
    };
    const workbook = await loaded(
      await buildTemplate({
        ...base,
        columns: [
          plain,
          { ...plain, header: "status", description: "The status.", values: ["Active", "Inactive"] },
        ],
        lists: { area: ["Maadi", "New Cairo"], status: ["Open", "Closed", "Held"] },
      }),
    );
    const data = workbook.getWorksheet("Contractors")!;
    const lists = workbook.getWorksheet("Lists")!;

    expect(lists.getColumn(1).values).toEqual([undefined, "Maadi", "New Cairo"]);
    // A list replaces the column's values for the dropdown.
    expect(lists.getColumn(2).values).toEqual([undefined, "Open", "Closed", "Held"]);
    expect(data.getCell("A2").dataValidation.formulae).toEqual(["Lists!$A$1:$A$2"]);
    expect(data.getCell("B2").dataValidation.formulae).toEqual(["Lists!$B$1:$B$3"]);
    // The instructions say what they always said: the values of a column, and nothing for a list.
    expect(instructionsOf(workbook)).toContain("The area.");
    expect(instructionsOf(workbook)).toContain("The status. One of: Active, Inactive.");
  });

  it("refuses a list for a header that is not a column", async () => {
    await expect(buildTemplate({ ...base, lists: { nope: ["x"] } })).rejects.toThrow(
      'The Contractors template has no column "nope" for a list',
    );
  });

  it("leaves a column without a dropdown when its list is empty", async () => {
    expect(rulesOf(dataXml(await buildTemplate({ ...base, lists: { area: [] } })))).toEqual([
      `C2:C${LAST_ROW}`,
    ]);
  });

  it("cuts a long title and a long message at a whole character, to what a spreadsheet keeps", async () => {
    const header = "😀".repeat(40);
    const names = Array.from({ length: 30 }, (_, at) => `${"Long name ".repeat(5)}${at}`);
    const workbook = await loaded(
      await buildTemplate({
        ...base,
        columns: [{ header, kind: "text", required: true, description: "", example: "" }],
        lists: { [header]: names },
      }),
    );
    const rule = workbook.getWorksheet("Contractors")!.getCell("A2").dataValidation;

    for (const text of [rule.promptTitle!, rule.errorTitle!]) {
      expect(text.length).toBeLessThanOrEqual(32);
      expect(text.endsWith("...")).toBe(true);
      expect(text).not.toMatch(LONE_SURROGATE);
      // A character cut in two is written as U+FFFD: the title keeps 14 whole emoji (28 units) and the dots.
      expect(text).toBe(`${"😀".repeat(14)}...`);
    }
    expect(rule.error!.length).toBeLessThanOrEqual(255);
    expect(rule.error!.startsWith("Choose one of: Long name Long name")).toBe(true);
    expect(rule.error!.endsWith("...")).toBe(true);
  });

  it("writes a name as the text it is: commas, quotes, ampersands, Arabic, a leading = + or ', spaces", async () => {
    const names = [
      "A, B",
      'say "hi"',
      "Tom & Jerry <x>",
      "مدينة نصر",
      "=SUM(1,2)",
      "'quoted",
      "+1",
      "  spaced  ",
      "50%",
    ];
    const lists = (await loaded(await buildTemplate({ ...base, lists: { area: names } }))).getWorksheet(
      "Lists",
    )!;

    names.forEach((name, at) => {
      const cell = lists.getCell(at + 1, 4);
      expect(cell.value, name).toBe(name);
      expect(cell.type, name).toBe(ExcelJS.ValueType.String);
    });
  });

  it("lists the first IMPORT_MAX_LIST_VALUES choices of a longer list, warns instead of stopping, and says so", async () => {
    const many = Array.from({ length: IMPORT_MAX_LIST_VALUES + 1 }, (_, at) => `Name ${at}`);
    const workbook = await loaded(await buildTemplate({ ...base, lists: { area: many } }));
    const lists = workbook.getWorksheet("Lists")!;
    const instructions = workbook.getWorksheet("Instructions")!;

    expect(lists.getCell(IMPORT_MAX_LIST_VALUES, 4).value).toBe(`Name ${IMPORT_MAX_LIST_VALUES - 1}`);
    expect(lists.getCell(IMPORT_MAX_LIST_VALUES + 1, 4).value).toBeNull();
    expect(workbook.getWorksheet("Contractors")!.getCell("D2").dataValidation).toMatchObject({
      formulae: [`Lists!$D$1:$D$${IMPORT_MAX_LIST_VALUES}`],
      errorStyle: "warning",
      error: "The list shows only the first 20,000 choices. Keep this value only if it is correct.",
    });
    expect(instructions.getCell(`C${instructions.rowCount}`).text).toBe(
      "The area. The dropdown shows the first 20,000 choices; any other value can be typed.",
    );
  }, 30_000);

  it("stops, and says nothing more, for a list of exactly IMPORT_MAX_LIST_VALUES choices", async () => {
    const exact = Array.from({ length: IMPORT_MAX_LIST_VALUES }, (_, at) => `Name ${at}`);
    const workbook = await loaded(await buildTemplate({ ...base, lists: { area: exact } }));
    const instructions = workbook.getWorksheet("Instructions")!;

    expect(workbook.getWorksheet("Contractors")!.getCell("D2").dataValidation).toMatchObject({
      formulae: [`Lists!$D$1:$D$${IMPORT_MAX_LIST_VALUES}`],
      errorStyle: "stop",
    });
    expect(instructions.getCell(`C${instructions.rowCount}`).text).toBe("The area.");
  }, 30_000);
});

describe("buildTemplate: the Lists sheet is not data", () => {
  const withLists: TemplateSpec = { ...base, lists: { area: ["Maadi", "New Cairo", "Zamalek"] } };

  it("is hidden and last, so the importer, which reads the first sheet only, never sees it", async () => {
    const workbook = await loaded(await buildTemplate(withLists));

    expect(workbook.worksheets.map((sheet) => [sheet.name, sheet.state])).toEqual([
      ["Contractors", "visible"],
      ["Instructions", "visible"],
      ["Lists", "hidden"],
    ]);
  });

  it("reads the same header and rows from a template with lists as from one without", async () => {
    const plain = await readXlsx(await buildTemplate(base), "plain.xlsx");
    const listed = await readXlsx(await buildTemplate(withLists), "listed.xlsx");

    expect(listed.headers).toEqual(plain.headers);
    expect(listed.rows).toEqual(plain.rows);
    expect(listed.rows).toHaveLength(1);
    expect(matchHeader(listed.headers, columns)).toEqual([0, 1, 2, 3]);
  });

  it("reads a filled-in file the same whatever the Lists sheet holds, even more rows than the data sheet has", async () => {
    const workbook = await loaded(await buildTemplate(withLists));
    const data = workbook.getWorksheet("Contractors")!;
    data.getRow(2).values = ["Nile", "0100 111 2222", "Active", "Maadi"];
    data.getRow(3).values = ["Delta", "0111 333 4444", "Inactive", "Zamalek"];
    const lists = workbook.getWorksheet("Lists")!;
    for (let row = 1; row <= 50; row++) {
      lists.getRow(row).values = ["x", "y", `row ${row}`, "Maadi"];
    }

    const sheet = await readXlsx(Buffer.from(await workbook.xlsx.writeBuffer()), "filled.xlsx");

    expect(sheet.rows).toEqual([
      { row: 2, cells: ["Nile", "0100 111 2222", "Active", "Maadi"] },
      { row: 3, cells: ["Delta", "0111 333 4444", "Inactive", "Zamalek"] },
    ]);
  });
});

describe("buildTemplate: the texts of a rule at their limits", () => {
  const ruleOf = async (header: string, names: readonly string[]) => {
    const workbook = await loaded(
      await buildTemplate({
        ...base,
        columns: [{ header, kind: "text", required: true, description: "", example: "" }],
        lists: { [header]: names },
      }),
    );
    return workbook.getWorksheet("Contractors")!.getCell("A2").dataValidation;
  };
  const named = (count: number): string[] => Array.from({ length: count }, (_, at) => `v${at + 1}`);

  it("names the first ten choices in the error, and ends with an ellipsis only when there are more", async () => {
    expect((await ruleOf("h", named(9))).error).toBe(`Choose one of: ${named(9).join(", ")}`);
    expect((await ruleOf("h", named(10))).error).toBe(`Choose one of: ${named(10).join(", ")}`);
    expect((await ruleOf("h", named(11))).error).toBe(`Choose one of: ${named(10).join(", ")}, ...`);
    expect((await ruleOf("h", named(12))).error).toBe(`Choose one of: ${named(10).join(", ")}, ...`);
  });

  it("keeps a title of 32 characters whole and cuts one of 33 to 29 and an ellipsis", async () => {
    const whole = await ruleOf("h".repeat(32), ["a"]);
    const cut = await ruleOf("h".repeat(33), ["a"]);

    expect([whole.promptTitle, whole.errorTitle]).toEqual(["h".repeat(32), "h".repeat(32)]);
    expect([cut.promptTitle, cut.errorTitle]).toEqual([`${"h".repeat(29)}...`, `${"h".repeat(29)}...`]);
  });

  it("keeps a message of 255 characters whole and cuts one of 256 to 252 and an ellipsis", async () => {
    // "Choose one of: " is 15 characters and the ten names are joined by 9 separators of 2: 222 characters of names make 255.
    const exact = [...Array.from({ length: 8 }, () => "n".repeat(22)), "m".repeat(23), "m".repeat(23)];
    const over = [...exact.slice(0, 9), "m".repeat(24)];

    const whole = (await ruleOf("h", exact)).error!;
    const cut = (await ruleOf("h", over)).error!;

    expect(whole).toBe(`Choose one of: ${exact.join(", ")}`);
    expect(whole).toHaveLength(255);
    expect(cut).toHaveLength(255);
    expect(cut).toBe(`${`Choose one of: ${over.join(", ")}`.slice(0, 252)}...`);
  });
});

describe("buildTemplate: a column that fits at the width ExcelJS takes for none", () => {
  it("is written with a width, so it does not open narrower than its longest cell", async () => {
    // Two characters of header and seven of example: seven and the padding make exactly 9.
    const workbook = await loaded(
      await buildTemplate({
        ...base,
        columns: [{ header: "ab", kind: "text", required: false, description: "", example: "1234567" }],
      }),
    );

    expect(workbook.getWorksheet("Contractors")!.getColumn(1).width).toBeGreaterThanOrEqual(9);
    expect(workbook.getWorksheet("Contractors")!.getColumn(1).width).toBeLessThan(10);
  });
});
