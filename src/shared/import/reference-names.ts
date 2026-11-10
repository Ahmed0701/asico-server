import { normalizeText } from "./keys.js";

// How a file names the records a row points to, so that an import finds the same record again. One rule, used by the villas
// export (the cells it writes) and by the import templates (the choices of a dropdown): an area is its name, and "Name, City"
// when another area has that name; a party is its name, and its phone when another party of the same kind has that name.

type Named = { id: string; name: string };

export type VillaReferenceData = {
  areas: readonly { id: string; name: string; city: string }[];
  civilEngineers: readonly { id: string; name: string; phone: string }[];
  electricalEngineers: readonly { id: string; name: string; phone: string }[];
  contractors: readonly { id: string; name: string; phone: string }[];
};

export type PartyKind = "civilEngineer" | "electricalEngineer" | "contractor";

// How a villa export writes the records a villa points to. (A record that is not in the book, such as one made after the book
// was read, is written as its name.)
export type VillaReferences = {
  area: (area: Named) => string;
  party: (kind: PartyKind, party: Named) => string;
};

// The names (ignoring case and extra spaces) that more than one of the records has.
export function sharedNames(records: readonly { name: string }[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const { name } of records) {
    const key = normalizeText(name);
    (seen.has(key) ? shared : seen).add(key);
  }
  return shared;
}

// How one area is written, given every area there is.
export function areaLabeller(
  areas: readonly { id: string; name: string; city: string }[],
): (area: Named) => string {
  const cities = new Map(areas.map((area) => [area.id, area.city] as const));
  const shared = sharedNames(areas);
  return ({ id, name }) => {
    const city = cities.get(id);
    return city !== undefined && shared.has(normalizeText(name)) ? `${name}, ${city}` : name;
  };
}

// How one party is written, given every party of its kind.
export function partyLabeller(
  parties: readonly { id: string; name: string; phone: string }[],
): (party: Named) => string {
  const phones = new Map(parties.map((party) => [party.id, party.phone] as const));
  const shared = sharedNames(parties);
  return ({ id, name }) => {
    const phone = phones.get(id);
    return phone !== undefined && shared.has(normalizeText(name)) ? phone : name;
  };
}

export function buildVillaReferences(data: VillaReferenceData): VillaReferences {
  const parties: Record<PartyKind, (party: Named) => string> = {
    civilEngineer: partyLabeller(data.civilEngineers),
    electricalEngineer: partyLabeller(data.electricalEngineers),
    contractor: partyLabeller(data.contractors),
  };
  return { area: areaLabeller(data.areas), party: (kind, party) => parties[kind](party) };
}
