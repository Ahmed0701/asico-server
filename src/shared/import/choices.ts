import {
  areaCell,
  buildAreaIndex,
  buildPartyIndex,
  partyCell,
  type AreaRecord,
  type PartyRecord,
} from "./cells.js";
import { areaLabeller, partyLabeller } from "./reference-names.js";

// The choices of a template's dropdown for a column that names a record. Every choice is a text the import resolves to
// exactly that record: the name the villas export would write (see reference-names.ts), checked with the import's own
// resolvers, so a record the import could not tell apart from another (two areas with the same name and city) has no choice
// rather than a choice that is refused.

// Alphabetical. The locale is fixed, so the order does not depend on the server; Arabic names come after Latin ones.
const alphabetical = new Intl.Collator("en");
// "V-2" before "V-10".
const natural = new Intl.Collator("en", { numeric: true });

const sorted = (texts: Iterable<string>, collator: Intl.Collator): string[] =>
  [...new Set(texts)].sort(collator.compare);

// Every area (an area has no status).
export function areaChoices(areas: readonly AreaRecord[]): string[] {
  const label = areaLabeller(areas);
  const index = buildAreaIndex(areas);
  const chosen: string[] = [];
  for (const area of areas) {
    const text = label(area);
    const found = areaCell(text, index, { required: true });
    if (found.ok && found.value === area.id) {
      chosen.push(text);
    }
  }
  return sorted(chosen, alphabetical);
}

// The active parties of one kind. A switched-off party still counts when the names are compared, because the import finds it
// and answers "inactive" or "ambiguous", never "not found".
export function partyChoices(parties: readonly PartyRecord[]): string[] {
  const label = partyLabeller(parties);
  const index = buildPartyIndex(parties);
  const chosen: string[] = [];
  for (const party of parties) {
    if (party.status !== "ACTIVE") {
      continue;
    }
    const text = label(party);
    const found = partyCell(text, index, { required: true, notFoundKey: "", inactiveKey: "" });
    if (found.ok && found.value === party.id) {
      chosen.push(text);
    }
  }
  return sorted(chosen, alphabetical);
}

// Every villa, by its number as it is stored (an exact number is always found, whatever other numbers look like it).
export function villaNumberChoices(villas: readonly { villaNumber: string }[]): string[] {
  return sorted(
    villas.map((villa) => villa.villaNumber),
    natural,
  );
}

// "1" to "5": a whole number typed into a text cell is read as digits.
export function wholeNumberChoices(min: number, max: number): string[] {
  return Array.from({ length: max - min + 1 }, (_, at) => String(min + at));
}
