// How two spellings of the same name or number are recognised as one. Used for the natural key of a record (to
// find a duplicate) and to match a cell to an option or a record by name.

// Trimmed, runs of whitespace collapsed to one space, compared without regard to case.
export function normalizeText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

// A phone number without the spaces and dashes it was typed with: "0100 123-4567" and "01001234567" are one number.
export function normalizePhone(phone: string): string {
  return phone.normalize("NFKC").replace(/[\s-]+/g, "");
}

// One string for a list of parts, so a pair of values can be a key in a Map or a Set.
export function joinKey(...parts: string[]): string {
  return parts.join("\u0000");
}
