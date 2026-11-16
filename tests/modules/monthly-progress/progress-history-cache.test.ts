import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonthlyProgressRepository } from "../../../src/modules/monthly-progress/repository/monthly-progress.repository.js";
import {
  clearProgressHistoryCache,
  PAST_PROGRESS_TTL_MS,
  ProgressHistory,
} from "../../../src/modules/monthly-progress/service/progress-history-cache.js";

// The past figures are worked out once and shared; now always comes from the open works as they are.

const phases = [{ id: "A", progressRatio: 100 }];
function fakeRepository() {
  return {
    activePhases: vi.fn(async () => phases),
    works: vi.fn(async () => [
      { id: "w1", villaId: "v1", elecPhaseId: "A", progress: 100, createdAt: new Date("2026-01-01") },
    ]),
    workEvents: vi.fn(async () => []),
    currentPhaseAverages: vi.fn(async () => [{ villaId: "v1", elecPhaseId: "A", progress: 40 }]),
  };
}

beforeEach(() => clearProgressHistoryCache());

describe("ProgressHistory", () => {
  it("reads the history once for many simultaneous requests of the same instants", async () => {
    const repo = fakeRepository();
    const history = new ProgressHistory(repo as unknown as MonthlyProgressRepository, () => 0);
    const instants = [new Date("2026-10-01T00:00:00Z"), new Date("2026-11-01T00:00:00Z")];

    const answers = await Promise.all(Array.from({ length: 20 }, () => history.at(instants)));

    expect(repo.workEvents).toHaveBeenCalledTimes(1);
    expect(repo.works).toHaveBeenCalledTimes(1);
    for (const [october, november] of answers) {
      expect(october!.get("v1")).toBe(100);
      expect(november!.get("v1")).toBe(100);
    }
  });

  it("reads it again once the figures are older than the time they are kept", async () => {
    const repo = fakeRepository();
    let now = 0;
    const history = new ProgressHistory(repo as unknown as MonthlyProgressRepository, () => now);
    const instant = [new Date("2026-10-01T00:00:00Z")];

    await history.at(instant);
    now = PAST_PROGRESS_TTL_MS - 1;
    await history.at(instant);
    expect(repo.workEvents).toHaveBeenCalledTimes(1);

    now = PAST_PROGRESS_TTL_MS + 1;
    await history.at(instant);
    expect(repo.workEvents).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed read", async () => {
    const repo = fakeRepository();
    repo.workEvents.mockRejectedValueOnce(new Error("down"));
    const history = new ProgressHistory(repo as unknown as MonthlyProgressRepository, () => 0);
    const instant = [new Date("2026-10-01T00:00:00Z")];

    await expect(history.at(instant)).rejects.toThrow("down");
    await expect(history.at(instant)).resolves.toHaveLength(1);
    expect(repo.workEvents).toHaveBeenCalledTimes(2);
  });

  it("takes now from the open works as they are, never from the cache", async () => {
    const repo = fakeRepository();
    const history = new ProgressHistory(repo as unknown as MonthlyProgressRepository, () => 0);

    expect((await history.current()).get("v1")).toBe(0);
    repo.currentPhaseAverages.mockResolvedValueOnce([{ villaId: "v1", elecPhaseId: "A", progress: 100 }]);
    expect((await history.current()).get("v1")).toBe(100);
    expect(repo.workEvents).not.toHaveBeenCalled();
  });
});
