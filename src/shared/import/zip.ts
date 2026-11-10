import { inflateRawSync } from "node:zlib";
import { fileProblems } from "./errors.js";
import { ZIP_MAX_ENTRIES, ZIP_MAX_ENTRY_BYTES, ZIP_MAX_TOTAL_BYTES } from "./limits.js";

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const END_OF_DIRECTORY_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const ZIP64_MARKER = 0xffffffff;

const STORED = 0;
const DEFLATED = 8;

// Every ZIP starts with a local file header.
export function hasZipSignature(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === LOCAL_HEADER;
}

function findEndOfDirectory(bytes: Buffer): number {
  // The record sits at the very end, followed only by a comment of at most 65535 bytes.
  const lowest = Math.max(0, bytes.length - END_OF_DIRECTORY_SIZE - 0xffff);
  for (let at = bytes.length - END_OF_DIRECTORY_SIZE; at >= lowest; at--) {
    if (bytes.readUInt32LE(at) === END_OF_DIRECTORY) {
      return at;
    }
  }
  return -1;
}

// Refuses a ZIP that is damaged, encrypted, or that would unpack to more than the limits allow. The sizes the
// archive declares are not trusted: every entry is inflated here with a cap on its output, and must come out at
// exactly the size it declared, so a bomb that lies about its size is stopped at the cap and never reaches the
// spreadsheet parser, which would otherwise unpack it into memory.
export function assertSafeZip(bytes: Buffer): void {
  const end = findEndOfDirectory(bytes);
  if (end < 0) {
    throw fileProblems.unreadable();
  }
  const entries = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryOffset = bytes.readUInt32LE(end + 16);
  if (entries === 0xffff || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) {
    // ZIP64 is only for archives far beyond what an import accepts.
    throw fileProblems.unreadable();
  }
  if (entries === 0 || entries > ZIP_MAX_ENTRIES || directoryOffset + directorySize > end) {
    throw fileProblems.unreadable();
  }

  let at = directoryOffset;
  let total = 0;
  for (let index = 0; index < entries; index++) {
    if (at + CENTRAL_HEADER_SIZE > bytes.length || bytes.readUInt32LE(at) !== CENTRAL_HEADER) {
      throw fileProblems.unreadable();
    }
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localOffset = bytes.readUInt32LE(at + 42);
    at += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;

    const encrypted = (flags & 1) !== 0;
    if (encrypted || compressedSize === ZIP64_MARKER || size === ZIP64_MARKER) {
      throw fileProblems.unreadable();
    }
    if (size > ZIP_MAX_ENTRY_BYTES) {
      throw fileProblems.tooLarge();
    }
    total += size;
    if (total > ZIP_MAX_TOTAL_BYTES) {
      throw fileProblems.tooLarge();
    }

    if (localOffset + LOCAL_HEADER_SIZE > bytes.length || bytes.readUInt32LE(localOffset) !== LOCAL_HEADER) {
      throw fileProblems.unreadable();
    }
    const dataStart =
      localOffset +
      LOCAL_HEADER_SIZE +
      bytes.readUInt16LE(localOffset + 26) +
      bytes.readUInt16LE(localOffset + 28);
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (data.length !== compressedSize) {
      throw fileProblems.unreadable();
    }
    if (inflatedSize(method, data, size) !== size) {
      throw fileProblems.unreadable();
    }
  }
}

// The size an entry really unpacks to, never reading more than `declared` bytes of output.
function inflatedSize(method: number, data: Buffer, declared: number): number {
  if (method === STORED) {
    return data.length;
  }
  if (method !== DEFLATED) {
    throw fileProblems.unreadable();
  }
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(declared, 1) }).length;
  } catch {
    // Damaged data, or more output than the entry declared.
    throw fileProblems.unreadable();
  }
}
