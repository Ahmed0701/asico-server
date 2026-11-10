import { describe, expect, it } from "vitest";
import { doneRatioOf, villaProgressOf } from "../../../src/modules/villa-progress/dto/villa-progress.dto.js";

describe("doneRatioOf", () => {
  it("is the phase's whole ratio once its open work is done", () => {
    expect(doneRatioOf({ progress: 100, progressRatio: 30 })).toBe(30);
  });

  it("is nothing before that, however far along the open work is", () => {
    expect(doneRatioOf({ progress: 99, progressRatio: 30 })).toBe(0);
    expect(doneRatioOf({ progress: 0, progressRatio: 30 })).toBe(0);
  });

  it("is nothing for a done phase whose ratio is 0", () => {
    expect(doneRatioOf({ progress: 100, progressRatio: 0 })).toBe(0);
  });
});

describe("villaProgressOf", () => {
  it("is what the done phases add up to", () => {
    expect(villaProgressOf(30 + 50)).toBe(80);
  });

  it("never goes past 100, even when the ratios add up to more", () => {
    expect(villaProgressOf(130)).toBe(100);
  });

  it("is 0 when no phase is done", () => {
    expect(villaProgressOf(0)).toBe(0);
  });
});
