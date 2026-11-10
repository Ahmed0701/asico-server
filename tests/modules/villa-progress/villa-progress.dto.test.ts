import { describe, expect, it } from "vitest";
import {
  MAX_PROGRESS,
  PROGRESS_STATES,
  averageProgress,
  stateOf,
} from "../../../src/modules/villa-progress/dto/villa-progress.dto.js";
import {
  updatePhaseProgressSchema,
  villaPhaseParams,
} from "../../../src/modules/villa-progress/validators/villa-progress.validators.js";

describe("stateOf", () => {
  it.each([
    [0, "NOT_STARTED"],
    [1, "IN_PROGRESS"],
    [50, "IN_PROGRESS"],
    [99, "IN_PROGRESS"],
    [100, "DONE"],
  ])("%i is %s", (progress, state) => {
    expect(stateOf(progress)).toBe(state);
  });

  it("names exactly three states", () => {
    expect([...PROGRESS_STATES]).toEqual(["NOT_STARTED", "IN_PROGRESS", "DONE"]);
    expect(MAX_PROGRESS).toBe(100);
  });
});

describe("averageProgress", () => {
  it.each([
    [0, 0, 0],
    [50, 0, 0],
    [0, 6, 0],
    [600, 6, 100],
    [300, 6, 50],
    [40, 6, 6.7],
    [1, 3, 0.3],
    [2, 3, 0.7],
    [1, 8, 0.1],
    [3, 8, 0.4],
    [5, 8, 0.6],
    [7, 8, 0.9],
    [599, 6, 99.8],
    [1, 1, 1],
    [100, 1, 100],
  ])("sum %i over %i phases is %f", (sum, count, expected) => {
    expect(averageProgress(sum, count)).toBe(expected);
  });

  it("rounds a half up to the next tenth, without floating-point drift", () => {
    // 0.05 and 0.15 are exact halves of a tenth: 1 / 20 and 3 / 20.
    expect(averageProgress(1, 20)).toBe(0.1);
    expect(averageProgress(3, 20)).toBe(0.2);
    expect(averageProgress(33.35 * 20, 20)).toBeCloseTo(33.4, 5);
  });

  it("is 0, never NaN or Infinity, with no phases or a negative count", () => {
    expect(averageProgress(0, 0)).toBe(0);
    expect(averageProgress(10, -1)).toBe(0);
    expect(Number.isFinite(averageProgress(100, 0))).toBe(true);
  });

  it("always has at most one decimal and stays within 0..100", () => {
    for (let count = 1; count <= 12; count += 1) {
      for (let sum = 0; sum <= count * 100; sum += Math.max(1, Math.floor(count / 2))) {
        const value = averageProgress(sum, count);
        expect(Math.round(value * 10) / 10).toBe(value);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe("updatePhaseProgressSchema", () => {
  const issues = (result: {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string }[] };
  }) =>
    result.success
      ? []
      : (result.error?.issues ?? []).map((i) => ({ path: i.path.join("."), message: i.message }));

  it.each([0, 1, 50, 99, 100])("accepts %i", (progress) => {
    expect(updatePhaseProgressSchema.parse({ progress })).toEqual({ progress });
  });

  it.each([-1, 101, 1.5, 0.5, 99.9, 100.1, Infinity, -Infinity, NaN, 1e21, Number.MAX_SAFE_INTEGER])(
    "rejects the number %s with one message",
    (progress) => {
      expect(issues(updatePhaseProgressSchema.safeParse({ progress }))).toEqual([
        { path: "progress", message: "validation.progressInvalid" },
      ]);
    },
  );

  it.each(["50", "", "abc", null, undefined, true, false, [], [50], {}])(
    "rejects %j (not a number) with one message",
    (progress) => {
      expect(issues(updatePhaseProgressSchema.safeParse({ progress }))).toEqual([
        { path: "progress", message: "validation.progressInvalid" },
      ]);
    },
  );

  it("rejects a missing field and any other field", () => {
    expect(updatePhaseProgressSchema.safeParse({}).success).toBe(false);
    expect(updatePhaseProgressSchema.safeParse({ progress: 5, version: 2 }).success).toBe(false);
    expect(updatePhaseProgressSchema.safeParse({ progress: 5, completedAt: "2026-01-01" }).success).toBe(
      false,
    );
    expect(updatePhaseProgressSchema.safeParse(null).success).toBe(false);
  });

  it("accepts -0 as 0", () => {
    expect(updatePhaseProgressSchema.safeParse({ progress: -0 }).success).toBe(true);
  });
});

describe("villaPhaseParams", () => {
  const id = "0b7e3c1e-5d52-4f0e-9a1d-6a3f2c9b7d11";

  it("takes two uuids", () => {
    expect(villaPhaseParams.parse({ villaId: id, elecPhaseId: id })).toEqual({
      villaId: id,
      elecPhaseId: id,
    });
  });

  it.each([{ villaId: "x", elecPhaseId: id }, { villaId: id, elecPhaseId: "x" }, { villaId: id }, {}])(
    "rejects %j",
    (params) => {
      expect(villaPhaseParams.safeParse(params).success).toBe(false);
    },
  );
});
