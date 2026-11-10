import { beforeEach, describe, expect, it, vi } from "vitest";

// Spies on the one call that unpacks an entry, so the cap on its output can be seen.
const inflate = vi.hoisted(() => ({ calls: [] as { size: number; maxOutputLength: number | undefined }[] }));
vi.mock("node:zlib", async (importActual) => {
  const actual = await importActual<typeof import("node:zlib")>();
  return {
    ...actual,
    inflateRawSync: ((data: Buffer, options?: { maxOutputLength?: number }) => {
      inflate.calls.push({ size: data.length, maxOutputLength: options?.maxOutputLength });
      return actual.inflateRawSync(data, options);
    }) as typeof actual.inflateRawSync,
  };
});

import {
  assertSafeZip,
  hasZipSignature,
  ImportFileError,
  ZIP_MAX_ENTRIES,
} from "../../../src/shared/import/index.js";
import { zipOf } from "./xlsx-fixtures.js";

beforeEach(() => {
  inflate.calls.length = 0;
});

describe("hasZipSignature", () => {
  it("is true for the first bytes of a ZIP, and false for anything else", () => {
    expect(hasZipSignature(zipOf([{ name: "a.xml", data: Buffer.from("x") }]))).toBe(true);
    expect(hasZipSignature(Buffer.from("PK\x03"))).toBe(false);
    expect(hasZipSignature(Buffer.from("PK\x05\x06"))).toBe(false);
    expect(hasZipSignature(Buffer.alloc(0))).toBe(false);
  });
});

describe("assertSafeZip", () => {
  it("accepts an ordinary archive, stored or deflated, and unpacks each entry once", () => {
    const zip = zipOf([
      { name: "a.xml", data: Buffer.from("<a>some text some text some text</a>") },
      { name: "b.bin", data: Buffer.from("stored"), stored: true },
    ]);

    expect(() => assertSafeZip(zip)).not.toThrow();
    expect(inflate.calls).toHaveLength(1);
  });

  it("never lets an entry unpack to more than it declared: the cap handed to zlib is the declared size", () => {
    const declared = 12;
    const zip = zipOf([{ name: "a.xml", data: Buffer.alloc(30 * 1024 * 1024), declaredSize: declared }]);

    expect(() => assertSafeZip(zip)).toThrow(ImportFileError);
    expect(inflate.calls).toEqual([{ size: expect.any(Number), maxOutputLength: declared }]);
  });

  it("caps an empty entry at one byte, not zero", () => {
    expect(() => assertSafeZip(zipOf([{ name: "empty.xml", data: Buffer.alloc(0) }]))).not.toThrow();
    expect(inflate.calls[0]?.maxOutputLength).toBe(1);
  });

  it("does not unpack anything once the declared sizes are over the limits", () => {
    const zip = zipOf([{ name: "a.xml", data: Buffer.from("x"), declaredSize: 20 * 1024 * 1024 }]);

    expect(() => assertSafeZip(zip)).toThrow(ImportFileError);
    expect(inflate.calls).toHaveLength(0);
  });

  it("finds the end of the archive behind a trailing comment", () => {
    const zip = zipOf([{ name: "a.xml", data: Buffer.from("x") }]);
    const withComment = Buffer.concat([
      zip.subarray(0, zip.length - 2),
      Buffer.from([5, 0]),
      Buffer.from("hello"),
    ]);

    expect(() => assertSafeZip(withComment)).not.toThrow();
  });
});

describe("assertSafeZip: the structure it refuses by itself", () => {
  // The reader's own parser would also refuse most of these, so they are checked here, without it.
  const one = () => zipOf([{ name: "a.xml", data: Buffer.from("x"), stored: true }]);
  const endOf = (zip: Buffer) => zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));

  it("accepts exactly the most entries it allows, and refuses one more", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, n) => ({ name: `e${n}.xml`, data: Buffer.from("x") }));

    expect(() => assertSafeZip(zipOf(entries(ZIP_MAX_ENTRIES)))).not.toThrow();
    expect(() => assertSafeZip(zipOf(entries(ZIP_MAX_ENTRIES + 1)))).toThrow(ImportFileError);
  });

  it("refuses an archive with no entries", () => {
    expect(() => assertSafeZip(zipOf([]))).toThrow(ImportFileError);
  });

  it("refuses an encrypted entry before unpacking anything", () => {
    const zip = zipOf([{ name: "a.xml", data: Buffer.from("x"), flags: 1 }]);

    expect(() => assertSafeZip(zip)).toThrow(ImportFileError);
    expect(inflate.calls).toHaveLength(0);
  });

  it("takes the last end record, not one that happens to be inside an entry", () => {
    const decoy = Buffer.concat([Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

    expect(() => assertSafeZip(zipOf([{ name: "a.bin", data: decoy, stored: true }]))).not.toThrow();
  });

  it("refuses a directory that says it is larger than the space before the end record", () => {
    const zip = one();
    zip.writeUInt32LE(zip.readUInt32LE(endOf(zip) + 12) + 100, endOf(zip) + 12);

    expect(() => assertSafeZip(zip)).toThrow(ImportFileError);
  });

  it("refuses a directory that starts beyond the end record", () => {
    const zip = one();
    zip.writeUInt32LE(zip.length, endOf(zip) + 16);

    expect(() => assertSafeZip(zip)).toThrow(ImportFileError);
  });
});
