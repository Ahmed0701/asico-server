import { z } from "zod";
import { required } from "../../../shared/validation/fields.js";
import { FALLBACK_NAME, MAX_NAME_LENGTH, PDF_SIGNATURE } from "../dto/villa-documents.dto.js";

const id = z.string(required).pipe(z.uuid({ error: "validation.idInvalid" }));

export const villaParams = z.strictObject({ villaId: id });
export const fileParams = z.strictObject({ id });

// POST /villa-documents/:id/link: save the file, or show it.
export const fileLinkBody = z.strictObject({
  disposition: z
    .enum(["attachment", "inline"], { error: "validation.dispositionInvalid" })
    .default("attachment"),
});

// GET /villa-documents/:id/file?token=: the signed link. The token is checked by the controller.
export const fileLinkQuery = z.strictObject({
  token: z
    .string(required)
    .min(1, { error: "validation.fileLinkInvalid" })
    .max(2048, { error: "validation.fileLinkInvalid" }),
});

// Control characters, line and paragraph separators, and invisible format characters (bidi overrides, zero
// width spaces, the byte order mark) can disguise a name. The joiners are kept: Persian and Arabic names use them.
const STRIP = /[\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf}/gu;
const PDF_EXTENSION = /\.pdf$/i;
const EXTENSION_LENGTH = ".pdf".length;

// The name is only ever stored and sent back in a header, never used as a path. Still: keep the last path
// segment, drop anything that is not text, cap the length, and make sure it ends in .pdf.
export function sanitizeOriginalName(raw: string): string {
  const lastSegment = raw.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const cleaned = lastSegment
    .replace(/[\t\n\v\f\r\u2028\u2029]/g, " ")
    .replace(STRIP, "")
    .replace(/\s+/g, " ")
    .trim();
  const stem = Array.from(
    cleaned
      .replace(PDF_EXTENSION, "")
      .replace(/^\.+/, "")
      .replace(/[. ]+$/, ""),
  )
    .slice(0, MAX_NAME_LENGTH - EXTENSION_LENGTH)
    .join("")
    .replace(/[. ]+$/, "");
  return `${stem || FALLBACK_NAME}.pdf`;
}

export function hasPdfSignature(head: Buffer): boolean {
  return head.length >= PDF_SIGNATURE.length && head.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);
}
