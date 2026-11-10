import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { writeXlsx } from "../../../src/shared/export/xlsx.js";
import { col, document, inChunks, render } from "./helpers.js";

async function load(bytes: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  expect(workbook.worksheets).toHaveLength(1);
  return workbook.worksheets[0]!;
}

const columns = [
  col("number", "Villa Number", "text"),
  col("phone", "Phone", "text"),
  col("plot", "Plot", "text"),
  col("notified", "Notified", "date"),
  col("created", "Created (UTC)", "datetime"),
  col("flag", "Checklist", "boolean"),
  col("count", "Villas", "integer"),
];

const rows = [
  {
    number: "P-001",
    phone: "0100 123 4567",
    plot: "007",
    notified: new Date("2026-01-05T00:00:00.000Z"),
    created: new Date("2026-03-04T05:06:00.000Z"),
    flag: true,
    count: 3,
  },
  {
    number: "P-002",
    phone: "00201001234567",
    plot: "0",
    notified: null,
    created: new Date("2026-03-05T23:59:00.000Z"),
    flag: false,
    count: 0,
  },
];

describe("writeXlsx", () => {
  it("writes a real workbook (a zip) with one sheet, named as asked", async () => {
    const { bytes } = await render(writeXlsx, document(columns, rows));

    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect((await load(bytes)).name).toBe("Test");
  });

  it("returns the number of data rows written", async () => {
    expect((await render(writeXlsx, document(columns, rows))).rows).toBe(2);
    expect((await render(writeXlsx, document(columns, []))).rows).toBe(0);
  });

  it("writes the header row first, with the column titles", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(columns.map((c) => c.title));
  });

  it("styles the header row: bold, filled", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

    const cell = sheet.getRow(1).getCell(1);
    expect(cell.font?.bold).toBe(true);
    expect(cell.fill).toMatchObject({ type: "pattern", pattern: "solid" });
    expect(sheet.getRow(2).getCell(1).font?.bold).not.toBe(true);
  });

  it("freezes the header row", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1, xSplit: 0 });
  });

  it("puts an auto-filter over the header and every data row", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

    expect(sheet.autoFilter).toBe("A1:G3");
  });

  describe("column widths", () => {
    const widthsOf = async (doc: ReturnType<typeof document>) =>
      (await load((await render(writeXlsx, doc)).bytes)).columns.map((c) => c.width);
    const wrapsIn = async (doc: ReturnType<typeof document>, column: number) =>
      (await load((await render(writeXlsx, doc)).bytes)).getRow(2).getCell(column).alignment?.wrapText ===
      true;

    it("fits each column to its longest value plus a little padding", async () => {
      const [a, b] = await widthsOf(
        document(
          [col("a", "Area"), col("b", "Block")],
          [
            { a: "5th Settlement , South", b: "West Arab" },
            { a: "New Cairo", b: "Block 12 of the Northern Quarter" },
          ],
        ),
      );

      expect(a).toBe(24);
      expect(b).toBe(34);
    });

    it("widens a column for a header longer than its values", async () => {
      const [width] = await widthsOf(document([col("a", "Expected Receipt Date Of Material")], [{ a: "x" }]));

      expect(width).toBeGreaterThanOrEqual("Expected Receipt Date Of Material".length);
    });

    it("never goes below 8 for a short column", async () => {
      const widths = await widthsOf(document([col("a", "A"), col("b", "B")], [{ a: "1", b: "" }]));

      expect(widths).toEqual([8, 8]);
    });

    it("never goes above 60: a longer value wraps within the column", async () => {
      const long = "A very long contractor name that goes on and on and on ".repeat(6).trim();
      const doc = () => document([col("a", "Contractors"), col("b", "Plot")], [{ a: long, b: "7" }]);

      expect(await widthsOf(doc())).toEqual([60, 8]);
      expect(await wrapsIn(doc(), 1)).toBe(true);
      expect(await wrapsIn(doc(), 2)).toBe(false);
    });

    it("does not wrap a column whose longest value fits", async () => {
      expect(await wrapsIn(document([col("a", "Area")], [{ a: "New Cairo" }]), 1)).toBe(false);
    });

    it("measures Arabic by the letters it shows", async () => {
      const [arabic, latin] = await widthsOf(
        document([col("a", "A"), col("b", "B")], [{ a: "شركة النيل للمقاولين", b: "x".repeat(20) }]),
      );

      expect(arabic).toBe(latin);
    });

    it("counts wide characters as two", async () => {
      const [wide, plain] = await widthsOf(
        document([col("a", "A"), col("b", "B")], [{ a: "漢".repeat(10), b: "x".repeat(10) }]),
      );

      expect(wide).toBe(22);
      expect(plain).toBe(12);
    });

    it("allows for the longest line of a value with line breaks", async () => {
      const [width] = await widthsOf(document([col("a", "A")], [{ a: "short\nthe longest line here\nmid" }]));

      expect(width).toBe("the longest line here".length + 2);
    });

    it("fits dates, timestamps, Yes/No and numbers to what they show", async () => {
      const widths = await widthsOf(
        document(
          [
            col("d", "D", "date"),
            col("t", "T", "datetime"),
            col("b", "B", "boolean"),
            col("n", "N", "integer"),
            col("big", "Big", "integer"),
          ],
          [
            {
              d: new Date("2026-01-05T00:00:00Z"),
              t: new Date("2026-03-04T05:06:00Z"),
              b: true,
              n: 5,
              big: 1234567890,
            },
          ],
        ),
      );

      expect(widths).toEqual([12, 22, 8, 8, 12]);
    });

    it("fits an amount to what its format shows: the thousands separators and the two decimals", async () => {
      const [width] = await widthsOf(document([col("a", "A", "amount")], [{ a: 1234567.5 }]));

      expect(width).toBe("1,234,567.50".length + 2);
    });

    it("fits an amount to the decimals of its currency: three for KWD, none for JPY", async () => {
      const amounts = { ...col("a", "A", "amount"), currencyKey: "c" };
      const [kwd] = await widthsOf(document([amounts, col("c", "C")], [{ a: 1234567.5, c: "KWD" }]));
      const [jpy] = await widthsOf(document([amounts, col("c", "C")], [{ a: 1234567, c: "JPY" }]));

      expect(kwd).toBe("1,234,567.500".length + 2);
      expect(jpy).toBe("1,234,567".length + 2);
    });

    it("looks at every row, not only the first ones", async () => {
      const many = Array.from({ length: 3000 }, (_, i) => ({ a: i === 2999 ? "x".repeat(30) : "short" }));
      const doc = { ...document([col("a", "A")], []), rows: inChunks(many, 500) };

      expect(await widthsOf(doc)).toEqual([32]);
    });

    it("keeps every column inside the limits whatever the data", async () => {
      const lengths = [0, 1, 7, 8, 9, 30, 58, 59, 60, 61, 200];
      const cols = lengths.map((_, i) => col(`c${i}`, `C${i}`));
      const data = [Object.fromEntries(lengths.map((length, i) => [`c${i}`, "y".repeat(length)]))];

      for (const width of await widthsOf(document(cols, data))) {
        expect(width).toBeGreaterThanOrEqual(8);
        expect(width).toBeLessThanOrEqual(60);
      }
    });

    it("keeps the types, the frozen header and the filter on a table whose columns were fitted", async () => {
      const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

      expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
      expect(sheet.autoFilter).toBe("A1:G3");
      expect(sheet.getRow(2).getCell(2).numFmt).toBe("@");
      expect(sheet.getRow(2).getCell(4).type).toBe(ExcelJS.ValueType.Date);
    });
  });

  it("writes dates and timestamps as real date cells with a date format", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

    const date = sheet.getRow(2).getCell(4);
    const timestamp = sheet.getRow(2).getCell(5);
    expect(date.type).toBe(ExcelJS.ValueType.Date);
    expect(date.value).toEqual(new Date("2026-01-05T00:00:00.000Z"));
    expect(date.numFmt).toBe("yyyy-mm-dd");
    expect(timestamp.type).toBe(ExcelJS.ValueType.Date);
    expect(timestamp.value).toEqual(new Date("2026-03-04T05:06:00.000Z"));
    expect(timestamp.numFmt).toBe('yyyy-mm-dd hh:mm "UTC"');
  });

  it("leaves an empty date cell empty", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

    expect(sheet.getRow(3).getCell(4).value).toBeNull();
  });

  it("keeps text as text: leading zeros, spaces and plus signs survive, and nothing becomes a number", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

    for (const [row, column, expected] of [
      [2, 2, "0100 123 4567"],
      [2, 3, "007"],
      [3, 2, "00201001234567"],
      [3, 3, "0"],
      [2, 1, "P-001"],
    ] as const) {
      const cell = sheet.getRow(row).getCell(column);
      expect(cell.type, `${row},${column}`).toBe(ExcelJS.ValueType.String);
      expect(cell.value).toBe(expected);
      expect(cell.numFmt).toBe("@");
    }
  });

  it("writes a boolean as Yes or No, and an integer as a number", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, rows))).bytes);

    expect(sheet.getRow(2).getCell(6).value).toBe("Yes");
    expect(sheet.getRow(3).getCell(6).value).toBe("No");
    expect(sheet.getRow(2).getCell(7).type).toBe(ExcelJS.ValueType.Number);
    expect(sheet.getRow(2).getCell(7).value).toBe(3);
    expect(sheet.getRow(3).getCell(7).value).toBe(0);
  });

  describe("formula injection", () => {
    const dangerous = [
      "=SUM(A1:A9)",
      "=cmd|' /C calc'!A0",
      "+1+1",
      "-2+3",
      "@SUM(1)",
      "\t=1+1",
      "\r=1+1",
      '=HYPERLINK("http://evil.example","x")',
    ];

    it.each(dangerous)("%j is written as plain text with a leading apostrophe", async (value) => {
      const sheet = await load((await render(writeXlsx, document([col("a", "A")], [{ a: value }]))).bytes);

      const cell = sheet.getRow(2).getCell(1);
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      // A carriage return is read back as a line feed (XML normalizes it); what matters is the apostrophe.
      expect(cell.value).toBe(`'${value}`.replace(/\r/g, "\n"));
      expect(cell.formula).toBeUndefined();
    });

    it("never writes a formula cell, whatever the data", async () => {
      const data = dangerous.map((value) => ({ a: value, b: value }));
      const sheet = await load(
        (await render(writeXlsx, document([col("a", "A"), col("b", "B", "text")], data))).bytes,
      );

      sheet.eachRow((row) =>
        row.eachCell((cell) => {
          expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        }),
      );
    });

    it("leaves ordinary text alone, including text that merely contains those characters", async () => {
      const values = ["Nile Builders", "a=b", "x+y", "e-mail", "name@example.test", "P-001", " =not first"];
      const sheet = await load(
        (
          await render(
            writeXlsx,
            document(
              [col("a", "A")],
              values.map((a) => ({ a })),
            ),
          )
        ).bytes,
      );

      expect(values.map((_, i) => sheet.getRow(i + 2).getCell(1).value)).toEqual(values);
    });

    it("protects the column titles' data in the summary block too", async () => {
      const sheet = await load(
        (await render(writeXlsx, document([col("a", "A")], [], { summary: [["Contractor", "=1+1"]] }))).bytes,
      );

      expect(sheet.getRow(1).getCell(2).value).toBe("'=1+1");
    });
  });

  describe("a summary block above the table", () => {
    // The rows are an async generator, which can be read once: each test builds its own document.
    const withSummary = () =>
      document(columns, rows, {
        summary: [
          ["Contractor", "Nile Builders"],
          ["Total villas", "3"],
        ],
      });

    it("writes the pairs, a blank row, then the header row", async () => {
      const sheet = await load((await render(writeXlsx, withSummary())).bytes);

      expect(sheet.getRow(1).getCell(1).value).toBe("Contractor");
      expect(sheet.getRow(1).getCell(2).value).toBe("Nile Builders");
      expect(sheet.getRow(2).getCell(2).value).toBe("3");
      expect(sheet.getRow(4).getCell(1).value).toBe("Villa Number");
      expect(sheet.getRow(5).getCell(1).value).toBe("P-001");
    });

    it("widens the first two columns for the summary's labels and values, not only for the table", async () => {
      const [first, second] = (await load((await render(writeXlsx, withSummary())).bytes)).columns.map(
        (c) => c.width ?? 0,
      );

      expect(first).toBeGreaterThanOrEqual("Total villas".length + 2);
      expect(second).toBeGreaterThanOrEqual("Nile Builders".length + 2);
    });

    it("freezes and filters from the table header, not from the top", async () => {
      const sheet = await load((await render(writeXlsx, withSummary())).bytes);

      expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
      expect(sheet.autoFilter).toBe("A4:G6");
    });
  });

  it("an empty export is still a valid workbook: the header only, filter over the header", async () => {
    const sheet = await load((await render(writeXlsx, document(columns, []))).bytes);

    expect(sheet.rowCount).toBe(1);
    expect(sheet.autoFilter).toBe("A1:G1");
  });

  it("writes many rows delivered in many chunks", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({
      number: `P-${String(i).padStart(5, "0")}`,
      phone: "0100",
      plot: String(i),
      notified: null,
      created: new Date("2026-01-01T00:00:00Z"),
      flag: i % 2 === 0,
      count: i,
    }));
    const doc = { ...document(columns, []), rows: inChunks(many, 1000) };

    const { bytes, rows: written } = await render(writeXlsx, doc);
    const sheet = await load(bytes);

    expect(written).toBe(2500);
    expect(sheet.rowCount).toBe(2501);
    expect(sheet.getRow(2501).getCell(1).value).toBe("P-02499");
    expect(sheet.autoFilter).toBe("A1:G2501");
  });

  it("writes Arabic text as it is", async () => {
    const sheet = await load(
      (await render(writeXlsx, document([col("a", "A")], [{ a: "شركة النيل Nile 7" }]))).bytes,
    );

    expect(sheet.getRow(2).getCell(1).value).toBe("شركة النيل Nile 7");
  });
});

describe("writeXlsx: an amount beside its currency", () => {
  const amounts = [
    { ...col("budget", "Budget", "amount"), currencyKey: "currency" },
    col("currency", "Currency"),
  ];

  it("shows the number with the decimals of the currency of its own row, and keeps its exact value", async () => {
    const { bytes } = await render(
      writeXlsx,
      document(amounts, [
        { budget: 1250.5, currency: "KWD" },
        { budget: 0.001, currency: "KWD" },
        { budget: 1250.5, currency: "EGP" },
        { budget: 1250, currency: "JPY" },
      ]),
    );
    const sheet = await load(bytes);

    expect([2, 3, 4, 5].map((row) => sheet.getRow(row).getCell(1).value)).toEqual([
      1250.5, 0.001, 1250.5, 1250,
    ]);
    expect([2, 3, 4, 5].map((row) => sheet.getRow(row).getCell(1).numFmt)).toEqual([
      "#,##0.000",
      "#,##0.000",
      "#,##0.00",
      "#,##0",
    ]);
  });

  it("gives a column that is not an amount its own format, even beside a currency", async () => {
    const { bytes } = await render(
      writeXlsx,
      document(
        [{ ...col("note", "Note"), currencyKey: "currency" }, col("currency", "Currency")],
        [{ note: "text", currency: "KWD" }],
      ),
    );

    expect((await load(bytes)).getRow(2).getCell(1).numFmt).toBe("@");
  });

  it("keeps the format of the column for a row without a currency, and for a column without a currency key", async () => {
    const { bytes } = await render(
      writeXlsx,
      document(
        [...amounts, col("plain", "Plain", "amount")],
        [
          { budget: null, currency: null, plain: 2.5 },
          { budget: 2.5, currency: "", plain: 2.5 },
        ],
      ),
    );
    const sheet = await load(bytes);

    expect(sheet.getRow(2).getCell(3).numFmt).toBe("#,##0.00#");
    // An empty currency is no currency (it must not stop the file from being written).
    expect(sheet.getRow(3).getCell(1).numFmt).toBe("#,##0.00#");
  });
});
