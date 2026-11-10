import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warn, error } = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../src/core/config/logger.js", () => ({
  logger: { warn, error, info: vi.fn() },
}));

import { startIntervalJob } from "../../../src/core/jobs/intervalJob.js";

beforeEach(() => {
  vi.useFakeTimers();
  warn.mockClear();
  error.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("startIntervalJob", () => {
  it("runs once at the start, then every interval", async () => {
    const run = vi.fn(async () => {});
    const job = startIntervalJob({ name: "t", intervalMs: 1000, run });

    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(4);
    job.stop();
  });

  it("does not run at the start when asked not to", async () => {
    const run = vi.fn(async () => {});
    const job = startIntervalJob({ name: "t", intervalMs: 1000, run, runAtStart: false });

    await vi.advanceTimersByTimeAsync(999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    job.stop();
  });

  it("stops when told to", async () => {
    const run = vi.fn(async () => {});
    const job = startIntervalJob({ name: "t", intervalMs: 1000, run, runAtStart: false });
    job.stop();

    await vi.advanceTimersByTimeAsync(5000);

    expect(run).not.toHaveBeenCalled();
  });

  it("logs a run that fails and still runs the next one", async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    const job = startIntervalJob({ name: "t", intervalMs: 1000, run });

    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);

    expect(run).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it("never overlaps two runs: a tick while one is going is skipped and logged", async () => {
    let release: () => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const job = startIntervalJob({ name: "t", intervalMs: 1000, run, runAtStart: false });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(3);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    job.stop();
  });

  it("does not keep the process alive: its timer is unref'd", () => {
    const unref = vi.fn();
    const interval = vi.spyOn(globalThis, "setInterval").mockReturnValue({ unref } as never);
    const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});

    const job = startIntervalJob({ name: "t", intervalMs: 1000, run: async () => {}, runAtStart: false });
    job.stop();

    expect(interval).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
