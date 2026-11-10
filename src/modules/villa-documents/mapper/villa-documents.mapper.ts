import {
  FALLBACK_NAME,
  type VillaDocumentDto,
  type VillaDocumentSnapshot,
} from "../dto/villa-documents.dto.js";
import type { StoredFileRow, VillaDocumentRow } from "../repository/villa-documents.repository.js";

export function toVillaDocumentDto(row: VillaDocumentRow): VillaDocumentDto {
  return {
    id: row.id,
    villaId: row.villaId,
    originalName: row.originalName,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    uploadedBy: { id: row.uploadedBy.id, name: row.uploadedBy.name },
    createdAt: row.createdAt.toISOString(),
  };
}

export function toDocumentSnapshot(row: StoredFileRow): VillaDocumentSnapshot {
  return {
    id: row.id,
    villaId: row.villaId,
    originalName: row.originalName,
    sizeBytes: row.sizeBytes,
    mimeType: row.mimeType,
    storageKey: row.storageKey,
  };
}

// Header values must be ASCII: the plain filename is a lossy fallback for old clients, and filename*
// (RFC 5987/6266) carries the real name, percent-encoded as UTF-8, so Arabic names survive.
function asciiFallback(name: string): string {
  const fallback = name
    .replace(/[^A-Za-z0-9 ._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  const stem = fallback.replace(/\.pdf$/i, "");
  return /[A-Za-z0-9]/.test(stem) ? fallback : `${FALLBACK_NAME}.pdf`;
}

// "attachment" saves the file; "inline" lets the browser show it (the PDF viewer of a new tab).
export function toContentDisposition(name: string, type: "attachment" | "inline" = "attachment"): string {
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encoded}`;
}
