import { describe, expect, it } from "vitest";
import {
  areaCell,
  areaChoices,
  buildAreaIndex,
  buildPartyIndex,
  buildVillaReferences,
  findVilla,
  buildVillaIndex,
  integerCell,
  partyCell,
  partyChoices,
  villaNumberChoices,
  wholeNumberChoices,
  type AreaRecord,
  type PartyRecord,
} from "../../../src/shared/import/index.js";

const party = (
  id: string,
  name: string,
  phone: string,
  status: PartyRecord["status"] = "ACTIVE",
): PartyRecord => ({
  id,
  name,
  phone,
  status,
});
const resolveParty = (records: readonly PartyRecord[], text: string) =>
  partyCell(text, buildPartyIndex(records), { required: true, notFoundKey: "x", inactiveKey: "y" });

describe("areaChoices", () => {
  const areas: AreaRecord[] = [
    { id: "a1", name: "New Cairo", city: "Cairo" },
    { id: "a2", name: "new  cairo", city: "Giza" },
    { id: "a3", name: "Maadi", city: "Cairo" },
    { id: "a4", name: "Zamalek", city: "Cairo" },
    { id: "a5", name: "Zamalek", city: "Cairo" },
    { id: "a6", name: "مدينة نصر", city: "القاهرة" },
    { id: "a7", name: "Heliopolis, Cairo", city: "Cairo" },
    { id: "a8", name: "Heliopolis", city: "Cairo" },
  ];

  it("writes an area as its name, and as name and city when another area has the name", () => {
    const choices = areaChoices(areas);

    expect(choices).toContain("Maadi");
    expect(choices).toContain("مدينة نصر");
    expect(choices).toContain("New Cairo, Cairo");
    expect(choices).toContain("new  cairo, Giza");
    expect(choices).not.toContain("New Cairo");
  });

  it("leaves out two areas the import cannot tell apart, even by name and city", () => {
    expect(areaChoices(areas)).not.toContain("Zamalek");
    expect(areaChoices(areas).some((choice) => choice.startsWith("Zamalek"))).toBe(false);
  });

  it("offers only choices the import resolves to exactly one area, and each area at most once", () => {
    const index = buildAreaIndex(areas);
    const found = areaChoices(areas).map((choice) => {
      const result = areaCell(choice, index, { required: true });
      expect(result.ok, choice).toBe(true);
      return result.ok ? result.value : undefined;
    });

    expect(new Set(found).size).toBe(found.length);
    // Every area but the two twins has a choice.
    expect([...found].sort()).toEqual(["a1", "a2", "a3", "a6", "a7", "a8"]);
  });

  it("leaves out an area whose text the import reads as another area: a name wins over Name, City", () => {
    // "palm, giza" is the name and city of the second area, but the import takes it for the name of the first (ignoring case).
    const tricky: AreaRecord[] = [
      { id: "x", name: "Palm, Giza", city: "Cairo" },
      { id: "r", name: "palm", city: "giza" },
      { id: "s", name: "Palm", city: "Alex" },
    ];

    expect(areaChoices(tricky)).toEqual(["Palm, Alex", "Palm, Giza"]);
  });

  it("is the text the villas export writes for the same area (one rule for both)", () => {
    const book = buildVillaReferences({
      areas,
      civilEngineers: [],
      electricalEngineers: [],
      contractors: [],
    });
    const written = areas.map((area) => book.area(area));

    for (const choice of areaChoices(areas)) {
      expect(written, choice).toContain(choice);
    }
    // And the export's text for every area the import can resolve is a choice.
    for (const area of areas.filter(({ id }) => id !== "a4" && id !== "a5")) {
      expect(areaChoices(areas), area.id).toContain(book.area(area));
    }
  });

  it("is alphabetical, case and accents aside, with Arabic after Latin, and has no choice twice", () => {
    const names = ["Zamalek", "maadi", "Agouza", "Heliopolis", "مدينة نصر", "Ägypten"].map(
      (name, at): AreaRecord => ({ id: `n${at}`, name, city: "C" }),
    );

    expect(areaChoices(names)).toEqual(["Agouza", "Ägypten", "Heliopolis", "maadi", "Zamalek", "مدينة نصر"]);
    expect(
      areaChoices([
        ...names,
        ...names.map((name) => ({ ...name, id: `${name.id}b`, name: `${name.name}!` })),
      ]),
    ).toHaveLength(12);
  });

  it("keeps the digits of a name as text: Tower 10 before Tower 9", () => {
    const towers = ["Tower 9", "Tower 10"].map((name, at): AreaRecord => ({ id: `t${at}`, name, city: "C" }));

    expect(areaChoices(towers)).toEqual(["Tower 10", "Tower 9"]);
  });

  it("has nothing to offer for no areas", () => {
    expect(areaChoices([])).toEqual([]);
  });
});

describe("partyChoices", () => {
  const parties: PartyRecord[] = [
    party("c1", "Mona", "0100 111 2222"),
    party("c2", " MONA ", "0100 333 4444"),
    party("c3", "Karim", "0100 555 6666"),
    party("c4", "Hany", "0100 777 8888", "INACTIVE"),
    party("c5", "Laila", "0102 555 6666"),
    party("c6", "laila", "0102 999 0000", "INACTIVE"),
    party("c7", "Twin", "0103 111 1111"),
    party("c8", "Twin", "0103 111 1111"),
    party("c9", "Omar", "0104 222 3333"),
  ];

  it("lists the active parties only, by name, and by phone when another party has the name", () => {
    expect(partyChoices(parties)).toEqual([
      "0100 111 2222",
      "0100 333 4444",
      "0102 555 6666",
      "Karim",
      "Omar",
    ]);
  });

  it("counts a switched-off party when it compares names: its twin is written by phone, as the import needs", () => {
    // "Laila" alone would be ambiguous (the import finds both Lailas), so the active one is written by phone.
    expect(partyChoices(parties)).not.toContain("Laila");
    expect(partyChoices(parties)).toContain("0102 555 6666");
    expect(resolveParty(parties, "Laila")).toMatchObject({
      ok: false,
      error: { code: "AMBIGUOUS_REFERENCE" },
    });
  });

  it("leaves out a party the import cannot tell apart from another (same name and same phone)", () => {
    expect(partyChoices(parties).some((choice) => choice === "Twin" || choice === "0103 111 1111")).toBe(
      false,
    );
  });

  it("offers only choices the import resolves to exactly the party they were made for", () => {
    const found = partyChoices(parties).map((choice) => {
      const result = resolveParty(parties, choice);
      expect(result.ok, choice).toBe(true);
      return result.ok ? result.value : undefined;
    });

    expect([...found].sort()).toEqual(["c1", "c2", "c3", "c5", "c9"]);
  });

  it("is the text the export writes for the same party (one rule for both)", () => {
    const book = buildVillaReferences({
      areas: [],
      civilEngineers: [],
      electricalEngineers: [],
      contractors: parties,
    });

    for (const choice of partyChoices(parties)) {
      expect(
        parties.map((record) => book.party("contractor", record)),
        choice,
      ).toContain(choice);
    }
    for (const record of parties.filter((p) => ["c1", "c2", "c3", "c5", "c9"].includes(p.id))) {
      expect(partyChoices(parties), record.id).toContain(book.party("contractor", record));
    }
  });

  it("writes a phone as it is stored, spaces and all, and sorts as text", () => {
    const written = partyChoices([
      party("p1", "Same", "0100 111 2222"),
      party("p2", "same", "0100-333-4444"),
    ]);

    expect(written).toEqual(["0100 111 2222", "0100-333-4444"]);
  });

  it("is alphabetical, with Arabic after Latin", () => {
    const named = ["Zaki", "ali", "Bassem", "أحمد", "Ola"].map((name, at) =>
      party(`n${at}`, name, `0100 000 000${at}`),
    );

    expect(partyChoices(named)).toEqual(["ali", "Bassem", "Ola", "Zaki", "أحمد"]);
  });

  it("has nothing to offer when no party is active", () => {
    expect(partyChoices([party("x", "Off", "1", "INACTIVE")])).toEqual([]);
    expect(partyChoices([])).toEqual([]);
  });
});

describe("villaNumberChoices", () => {
  it("lists every number as it is stored, in natural order: V-2 before V-10", () => {
    const numbers = ["V-10", "V-2", "V-1", "A-9", "2235", "30"].map((villaNumber) => ({ villaNumber }));

    expect(villaNumberChoices(numbers)).toEqual(["30", "2235", "A-9", "V-1", "V-2", "V-10"]);
  });

  it("keeps two numbers that differ only in case (they are two villas), and the import finds each exactly", () => {
    const villas = [{ villaNumber: "v-1" }, { villaNumber: "V-1" }];
    const index = buildVillaIndex(villas);

    expect(villaNumberChoices(villas).sort()).toEqual(["V-1", "v-1"]);
    for (const choice of villaNumberChoices(villas)) {
      expect(findVilla(index, choice)).toEqual({ villaNumber: choice });
    }
  });

  it("lists a number once", () => {
    expect(villaNumberChoices([{ villaNumber: "V-1" }, { villaNumber: "V-1" }])).toEqual(["V-1"]);
  });

  it("has nothing to offer for no villas", () => {
    expect(villaNumberChoices([])).toEqual([]);
  });
});

describe("wholeNumberChoices", () => {
  it("is the digits from the lowest to the highest, as text, and each is a rating the import reads", () => {
    expect(wholeNumberChoices(1, 5)).toEqual(["1", "2", "3", "4", "5"]);
    for (const choice of wholeNumberChoices(1, 5)) {
      expect(integerCell(choice, { required: true, min: 1, max: 5, key: "x" })).toEqual({
        ok: true,
        value: Number(choice),
      });
    }
  });
});
