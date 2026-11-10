import { describe, expect, it } from "vitest";
import { buildVillaReferences } from "../../../src/modules/villas/service/villa-references.js";

// How the villas export writes the records a villa points to, so that the villas import finds the same record again: the name,
// and the city (for an area) or the phone (for a person) only when another record of the same kind has that name.
const data = {
  areas: [
    { id: "a1", name: "New Cairo", city: "Cairo" },
    { id: "a2", name: "new  cairo", city: "Giza" },
    { id: "a3", name: "Maadi", city: "Cairo" },
  ],
  civilEngineers: [
    { id: "e1", name: "Mona", phone: "0100 111 2222" },
    { id: "e2", name: " MONA ", phone: "0100 333 4444" },
    { id: "e3", name: "Karim", phone: "0100 555 6666" },
  ],
  electricalEngineers: [{ id: "x1", name: "Mona", phone: "0101 777 8888" }],
  contractors: [
    { id: "c1", name: "Nile", phone: "0102 111 1111" },
    { id: "c2", name: "Nile", phone: "0102 222 2222" },
    { id: "c3", name: "Delta", phone: "0102 333 3333" },
  ],
};
const references = buildVillaReferences(data);

describe("the areas", () => {
  it("are written as their name when no other area has it", () => {
    expect(references.area({ id: "a3", name: "Maadi" })).toBe("Maadi");
  });

  it("are written as name and city when another area has the name, ignoring case and extra spaces", () => {
    expect(references.area({ id: "a1", name: "New Cairo" })).toBe("New Cairo, Cairo");
    expect(references.area({ id: "a2", name: "new  cairo" })).toBe("new  cairo, Giza");
  });

  it("are written as their name when the book does not know them", () => {
    expect(references.area({ id: "gone", name: "New Cairo" })).toBe("New Cairo");
  });
});

describe("the people", () => {
  it("are written as their name when no other of the same kind has it", () => {
    expect(references.party("civilEngineer", { id: "e3", name: "Karim" })).toBe("Karim");
    expect(references.party("contractor", { id: "c3", name: "Delta" })).toBe("Delta");
  });

  it("are written as their phone, as stored, when another of the same kind has the name, ignoring case and spaces", () => {
    expect(references.party("civilEngineer", { id: "e1", name: "Mona" })).toBe("0100 111 2222");
    expect(references.party("civilEngineer", { id: "e2", name: " MONA " })).toBe("0100 333 4444");
    expect(references.party("contractor", { id: "c2", name: "Nile" })).toBe("0102 222 2222");
  });

  it("share a name with another kind without it counting: each kind is checked on its own", () => {
    expect(references.party("electricalEngineer", { id: "x1", name: "Mona" })).toBe("Mona");
  });

  it("are written as their name when the book does not know them", () => {
    expect(references.party("contractor", { id: "gone", name: "Nile" })).toBe("Nile");
    expect(references.party("civilEngineer", { id: "e1", name: "Mona" })).not.toBe("Mona");
  });

  it("look in the book of their own kind, not another", () => {
    expect(references.party("contractor", { id: "e1", name: "Mona" })).toBe("Mona");
    expect(references.party("electricalEngineer", { id: "c1", name: "Nile" })).toBe("Nile");
  });
});
