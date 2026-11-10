// Only PDFs are accepted. The type is decided by the file's first bytes, never by its name or the client.
export const PDF_MIME = "application/pdf";
export const PDF_SIGNATURE = Buffer.from("%PDF-");

export const MAX_NAME_LENGTH = 255;
export const FALLBACK_NAME = "file";

export type VillaDocumentDto = {
  id: string;
  villaId: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  uploadedBy: { id: string; name: string };
  createdAt: string;
};

export type UploadInput = {
  villaId: string;
  tempPath: string;
  originalName: string;
};

// What an audit entry records about a document.
export type VillaDocumentSnapshot = {
  id: string;
  villaId: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  storageKey: string;
};
