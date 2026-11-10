import type { PartyStatusValue } from "../constants/enums.js";
import { normalizePhone, normalizeText } from "./keys.js";
import type { CellIssue, RawCell } from "./types.js";

// The villas a file's rows can name, found by their number: exactly as it is stored first, and otherwise ignoring case and
// extra spaces. (The database keeps "v-1" and "V-1" apart, so a number that fits two villas loosely and none exactly is
// ambiguous, never a guess.)
export type VillaIndex<V extends { villaNumber: string }> = {
  exact: ReadonlyMap<string, V>;
  loose: ReadonlyMap<string, readonly V[]>;
};

export function buildVillaIndex<V extends { villaNumber: string }>(villas: readonly V[]): VillaIndex<V> {
  const loose = new Map<string, V[]>();
  for (const villa of villas) {
    const key = normalizeText(villa.villaNumber);
    loose.set(key, [...(loose.get(key) ?? []), villa]);
  }
  return { exact: new Map(villas.map((villa) => [villa.villaNumber, villa] as const)), loose };
}

// The villa a cell names: the villa, "ambiguous" when two villas fit and none is written exactly, or undefined.
export function findVilla<V extends { villaNumber: string }>(
  index: VillaIndex<V>,
  text: string,
): V | "ambiguous" | undefined {
  const exact = index.exact.get(text);
  if (exact !== undefined) {
    return exact;
  }
  const candidates = index.loose.get(normalizeText(text)) ?? [];
  if (candidates.length > 1) {
    return "ambiguous";
  }
  return candidates[0];
}

// The villa a row names, or undefined after adding the row's issue: not found, or ambiguous.
export function resolveVilla<V extends { villaNumber: string }>(
  issues: CellIssue[],
  index: VillaIndex<V>,
  column: string,
  text: string | undefined,
  value: RawCell,
): V | undefined {
  if (text === undefined) {
    return undefined;
  }
  const found = findVilla(index, text);
  if (found !== undefined && found !== "ambiguous") {
    return found;
  }
  issues.push(
    found === "ambiguous"
      ? { column, code: "AMBIGUOUS_REFERENCE", key: "import.villaAmbiguous", value }
      : { column, code: "REFERENCE_NOT_FOUND", key: "import.villaNotFound", value },
  );
  return undefined;
}

// What an import whose rows name a villa and, optionally, its contractor checks them against: the villas by number, and
// the contractors by name and by phone. Shared by every import of a villa's own records (open works, daily reports).
export type ImportVilla = { id: string; villaNumber: string; contractorId: string | null };
export type ImportContractor = { id: string; name: string; phone: string; status: PartyStatusValue };

export type VillaLookups = {
  villas: VillaIndex<ImportVilla>;
  contractors: ReadonlyMap<string, ImportContractor>;
  names: ReadonlySet<string>;
  phones: ReadonlySet<string>;
};

export function buildVillaLookups(
  villas: readonly ImportVilla[],
  contractors: readonly ImportContractor[],
): VillaLookups {
  return {
    villas: buildVillaIndex(villas),
    contractors: new Map(contractors.map((contractor) => [contractor.id, contractor] as const)),
    names: new Set(contractors.map((contractor) => normalizeText(contractor.name))),
    phones: new Set(contractors.map((contractor) => normalizePhone(contractor.phone))),
  };
}

const namesContractor = (contractor: ImportContractor, text: string): boolean =>
  normalizeText(contractor.name) === normalizeText(text) ||
  normalizePhone(contractor.phone) === normalizePhone(text);

export type ContractorOutcome =
  | { ok: true; contractorId: string }
  | { ok: false; code: "REFERENCE_NOT_FOUND" | "CONTRACTOR_NOT_ON_VILLA" | "INVALID_VALUE"; key: string };

// The same rules as the API, in the same order: the contractor exists, is the villa's one, and is active. `inactiveKey`
// is the message for a contractor that is switched off, which names the kind of record.
export function checkVillaContractor(
  text: string,
  villa: ImportVilla,
  lookups: VillaLookups,
  inactiveKey: string,
): ContractorOutcome {
  const own = villa.contractorId === null ? undefined : lookups.contractors.get(villa.contractorId);
  if (own !== undefined && namesContractor(own, text)) {
    return own.status === "INACTIVE"
      ? { ok: false, code: "INVALID_VALUE", key: inactiveKey }
      : { ok: true, contractorId: own.id };
  }
  if (lookups.names.has(normalizeText(text)) || lookups.phones.has(normalizePhone(text))) {
    return { ok: false, code: "CONTRACTOR_NOT_ON_VILLA", key: "errors.contractorNotOnVilla" };
  }
  return { ok: false, code: "REFERENCE_NOT_FOUND", key: "import.contractorNotFound" };
}
