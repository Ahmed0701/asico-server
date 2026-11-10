import { describe, expect, it } from "vitest";
import ar from "../../src/core/i18n/locales/ar.json" with { type: "json" };
import en from "../../src/core/i18n/locales/en.json" with { type: "json" };

describe("locales", () => {
  it("define the same keys in en and ar", () => {
    expect(Object.keys(ar).sort()).toEqual(Object.keys(en).sort());
  });
});
