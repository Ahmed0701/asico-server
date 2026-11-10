import { describe, expect, it } from "vitest";
import { toContentDisposition } from "../../../src/modules/villa-documents/mapper/villa-documents.mapper.js";
import {
  fileParams,
  hasPdfSignature,
  villaParams,
  sanitizeOriginalName,
} from "../../../src/modules/villa-documents/validators/villa-documents.validators.js";

const BACKSLASH = String.fromCharCode(92);
const UUID = "11111111-1111-4111-8111-111111111111";

describe("sanitizeOriginalName", () => {
  it.each([
    ["plan.pdf", "plan.pdf"],
    ["Plan.PDF", "Plan.pdf"],
    ["my plan 2026.pdf", "my plan 2026.pdf"],
    ["تقرير الموقع.pdf", "تقرير الموقع.pdf"],
    ["scan", "scan.pdf"],
    ["scan.png", "scan.png.pdf"],
    ["setup.exe", "setup.exe.pdf"],
    ["../../etc/passwd", "passwd.pdf"],
    [`..${BACKSLASH}..${BACKSLASH}windows${BACKSLASH}system32${BACKSLASH}cmd.exe`, "cmd.exe.pdf"],
    ["/etc/shadow", "shadow.pdf"],
    [`C:${BACKSLASH}Users${BACKSLASH}me${BACKSLASH}report.pdf`, "report.pdf"],
    ["folder/sub/report.pdf", "report.pdf"],
    [".hidden.pdf", "hidden.pdf"],
    ["...pdf", "file.pdf"],
    ["..", "file.pdf"],
    [".", "file.pdf"],
    ["", "file.pdf"],
    ["   ", "file.pdf"],
    [".pdf", "file.pdf"],
    ["report.pdf   ", "report.pdf"],
    ["report...", "report.pdf"],
    ["a   b\t\tc.pdf", "a b c.pdf"],
  ])("%j becomes %j", (raw, expected) => {
    expect(sanitizeOriginalName(raw)).toBe(expected);
  });

  it("removes control characters, line breaks and the null byte", () => {
    expect(sanitizeOriginalName("re\u0000po\u0007rt\r\n.pdf")).toBe("report.pdf");
    expect(sanitizeOriginalName("a\u007Fb\u0085c.pdf")).toBe("abc.pdf");
    expect(sanitizeOriginalName("one two three.pdf")).toBe("one two three.pdf");
  });

  it("removes characters that disguise a name: bidi overrides, zero-width spaces, the byte order mark", () => {
    // "invoice‮fdp.exe" would display as "invoiceexe.pdf" when the override is honoured.
    expect(sanitizeOriginalName("invoice‮fdp.exe")).toBe("invoicefdp.exe.pdf");
    expect(sanitizeOriginalName("a​b‎c⁦d﻿e.pdf")).toBe("abcde.pdf");
  });

  it("keeps the joiners that Arabic and Persian names use", () => {
    expect(sanitizeOriginalName("می‌خواهم.pdf")).toBe("می‌خواهم.pdf");
  });

  it("normalizes to NFC", () => {
    expect(sanitizeOriginalName("café.pdf")).toBe("café.pdf");
  });

  it("caps the length at 255 characters, counting code points, and keeps the extension", () => {
    const long = sanitizeOriginalName(`${"a".repeat(1000)}.pdf`);
    expect(Array.from(long)).toHaveLength(255);
    expect(long.endsWith(".pdf")).toBe(true);

    const arabic = sanitizeOriginalName(`${"ع".repeat(400)}.pdf`);
    expect(Array.from(arabic)).toHaveLength(255);
    expect(arabic.endsWith(".pdf")).toBe(true);

    const emoji = sanitizeOriginalName(`${"😀".repeat(300)}.pdf`);
    expect(Array.from(emoji)).toHaveLength(255);
  });

  it("never returns a name with a path separator, a leading dot, or no extension", () => {
    const hostile = [
      "../../../x",
      "..%2f..%2fx",
      `....${BACKSLASH}....${BACKSLASH}x`,
      "x/../../y",
      "‮‮",
      "a/b\\c/d.pdf/",
      "/",
      BACKSLASH,
    ];
    for (const raw of hostile) {
      const name = sanitizeOriginalName(raw);
      expect(name, raw).not.toMatch(/[\\/]/);
      expect(name, raw).not.toMatch(/^\./);
      expect(name, raw).toMatch(/\.pdf$/);
      expect(name.length, raw).toBeGreaterThan(4);
    }
  });
});

describe("hasPdfSignature", () => {
  it.each([
    ["%PDF-1.7", true],
    ["%PDF-", true],
    ["%PDF-2.0\n%âãÏÓ", true],
    ["%PDF", false],
    ["", false],
    [" %PDF-1.4", false],
    ["﻿%PDF-1.4", false],
    ["%pdf-1.4", false],
    ["PK\u0003\u0004", false],
    ["MZ", false],
    ["GIF89a%PDF-", false],
  ])("%j is %s", (content, expected) => {
    expect(hasPdfSignature(Buffer.from(content))).toBe(expected);
  });
});

describe("toContentDisposition", () => {
  it("is an attachment with an ASCII fallback and the real name as RFC 5987 UTF-8", () => {
    expect(toContentDisposition("plan.pdf")).toBe(
      `attachment; filename="plan.pdf"; filename*=UTF-8''plan.pdf`,
    );
  });

  it("encodes an Arabic name and falls back to a plain name", () => {
    const header = toContentDisposition("تقرير الموقع.pdf");

    expect(header).toBe(
      `attachment; filename="file.pdf"; filename*=UTF-8''${encodeURIComponent("تقرير الموقع.pdf")}`,
    );
    expect(header).toContain("%D8%AA%D9%82%D8%B1%D9%8A%D8%B1%20");
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1] ?? "")).toBe("تقرير الموقع.pdf");
  });

  it("keeps the Latin part of a mixed name in the fallback", () => {
    const header = toContentDisposition("تقرير Site 7.pdf");

    expect(header).toMatch(/filename="[A-Za-z0-9 ._-]*Site 7\.pdf"/);
    expect(header).toContain("filename*=UTF-8''");
  });

  it("is plain ASCII, so it is always a legal header value", () => {
    for (const name of [
      "تقرير.pdf",
      'a"b.pdf',
      "a;b=c.pdf",
      "x'y(z)*.pdf",
      "50%.pdf",
      "😀.pdf",
      "a\\b.pdf",
    ]) {
      const header = toContentDisposition(name);
      expect(header, name).toMatch(/^[\x20-\x7E]*$/);
    }
  });

  it("cannot be broken out of by a quote, a semicolon or a percent sign in the name", () => {
    const header = toContentDisposition('a"; filename="evil.exe');

    expect(header.match(/filename=/g)).toHaveLength(1);
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header).toContain("%22%3B%20filename%3D%22evil.exe");
    expect(header.startsWith("attachment; ")).toBe(true);
  });

  it("encodes the characters encodeURIComponent leaves alone but RFC 5987 does not allow", () => {
    const header = toContentDisposition("it's (a) *test*.pdf");

    expect(header).toContain("it%27s%20%28a%29%20%2Atest%2A.pdf");
  });
});

describe("params", () => {
  it("accepts uuids and rejects everything else", () => {
    expect(villaParams.safeParse({ villaId: UUID }).success).toBe(true);
    expect(fileParams.safeParse({ id: UUID }).success).toBe(true);

    expect(villaParams.safeParse({ villaId: "nope" }).success).toBe(false);
    expect(fileParams.safeParse({ id: `${UUID}/../x` }).success).toBe(false);
    expect(fileParams.safeParse({}).success).toBe(false);
    expect(fileParams.safeParse({ id: UUID, extra: "x" }).success).toBe(false);
  });
});
