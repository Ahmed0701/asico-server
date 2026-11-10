import { describe, expect, it } from "vitest";
import {
  alertWindow,
  deadlineOf,
  deadlineState,
  isTimeZone,
  localDayOf,
  nextDay,
  startOfLocalDay,
  type DeadlinePolicy,
} from "../../src/shared/utils/deadline.js";

const kuwait: DeadlinePolicy = { timeZone: "Asia/Kuwait", hoursBefore: 8 };
const at = (iso: string): Date => new Date(iso);

// Kuwait is UTC+3 all year. A work ending on 2026-11-05 is overdue from 2026-11-06 00:00 local (2026-11-05T21:00Z) and due soon
// from 8 hours before that (2026-11-05T13:00Z, which is 16:00 local).
const stateAt = (iso: string, endDay = "2026-11-05", pending = true, policy = kuwait) =>
  deadlineState(endDay, pending, alertWindow(at(iso), policy), policy);

describe("localDayOf", () => {
  it("gives the day of the zone, not the UTC day", () => {
    expect(localDayOf(at("2026-11-05T20:59:59.999Z"), "Asia/Kuwait")).toBe("2026-11-05");
    expect(localDayOf(at("2026-11-05T21:00:00.000Z"), "Asia/Kuwait")).toBe("2026-11-06");
    expect(localDayOf(at("2026-11-05T21:00:00.000Z"), "UTC")).toBe("2026-11-05");
  });

  it("goes back across the date line", () => {
    expect(localDayOf(at("2026-11-05T05:00:00.000Z"), "America/New_York")).toBe("2026-11-05");
    expect(localDayOf(at("2026-11-05T03:00:00.000Z"), "America/New_York")).toBe("2026-11-04");
  });
});

describe("nextDay", () => {
  it("crosses month and year ends and leap days", () => {
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
    expect(nextDay("2027-02-28")).toBe("2027-03-01");
  });
});

describe("isTimeZone", () => {
  it("accepts IANA names and refuses everything else", () => {
    expect(isTimeZone("Asia/Kuwait")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("+03:00")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone("Asia/Kuwait; drop")).toBe(false);
  });
});

describe("startOfLocalDay and deadlineOf", () => {
  it("is 00:00 local, i.e. 21:00Z the evening before for Kuwait", () => {
    expect(startOfLocalDay("2026-11-06", "Asia/Kuwait").toISOString()).toBe("2026-11-05T21:00:00.000Z");
    expect(deadlineOf("2026-11-05", kuwait).toISOString()).toBe("2026-11-05T21:00:00.000Z");
  });

  it("follows daylight saving: the day of the change has 23 or 25 hours", () => {
    const ny: DeadlinePolicy = { timeZone: "America/New_York", hoursBefore: 8 };
    // Spring forward on 2026-03-08 (EST, UTC-5, then EDT, UTC-4), fall back on 2026-11-01 (EDT, then EST).
    expect(deadlineOf("2026-03-07", ny).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(deadlineOf("2026-03-08", ny).toISOString()).toBe("2026-03-09T04:00:00.000Z");
    expect(deadlineOf("2026-10-31", ny).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(deadlineOf("2026-11-01", ny).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("starts a day whose midnight does not exist at the end of the gap", () => {
    // Sao Paulo used to skip midnight on the day daylight saving started; Havana still does (00:00 becomes 01:00).
    const start = startOfLocalDay("2026-03-08", "America/Havana");
    expect(localDayOf(start, "America/Havana")).toBe("2026-03-08");
    expect(localDayOf(new Date(start.getTime() - 1), "America/Havana")).toBe("2026-03-07");
  });
});

describe("startOfLocalDay keeps each zone's answer apart", () => {
  it("does not hand the answer for one zone to another zone asking for the same day", () => {
    const kuwaitFirst = startOfLocalDay("2027-02-14", "Asia/Kuwait").toISOString();
    const utc = startOfLocalDay("2027-02-14", "UTC").toISOString();
    const newYork = startOfLocalDay("2027-02-14", "America/New_York").toISOString();
    const kuwaitAgain = startOfLocalDay("2027-02-14", "Asia/Kuwait").toISOString();

    expect(kuwaitFirst).toBe("2027-02-13T21:00:00.000Z");
    expect(utc).toBe("2027-02-14T00:00:00.000Z");
    expect(newYork).toBe("2027-02-14T05:00:00.000Z");
    expect(kuwaitAgain).toBe(kuwaitFirst);
  });
});

describe("alertWindow", () => {
  it("is the zone's today and the zone's day hoursBefore from now", () => {
    expect(alertWindow(at("2026-11-05T12:59:59.999Z"), kuwait)).toEqual({
      today: "2026-11-05",
      horizon: "2026-11-05",
    });
    expect(alertWindow(at("2026-11-05T13:00:00.000Z"), kuwait)).toEqual({
      today: "2026-11-05",
      horizon: "2026-11-06",
    });
  });
});

describe("deadlineState in Asia/Kuwait", () => {
  it("is neither due soon nor overdue until 8 hours before the end of the end date", () => {
    const state = stateAt("2026-11-05T12:59:59.999Z");
    expect(state.dueSoon).toBe(false);
    expect(state.overdue).toBe(false);
    expect(state.deadlineAt.toISOString()).toBe("2026-11-05T21:00:00.000Z");
  });

  it("is due soon from exactly 8 hours before the deadline", () => {
    expect(stateAt("2026-11-05T13:00:00.000Z")).toMatchObject({ dueSoon: true, overdue: false });
    expect(stateAt("2026-11-05T20:59:59.999Z")).toMatchObject({ dueSoon: true, overdue: false });
  });

  it("is overdue from exactly the deadline, and no longer due soon", () => {
    expect(stateAt("2026-11-05T21:00:00.000Z")).toMatchObject({ dueSoon: false, overdue: true });
    expect(stateAt("2026-12-30T00:00:00.000Z")).toMatchObject({ dueSoon: false, overdue: true });
  });

  it("is due soon the whole day before when the alert window is 24 hours or more", () => {
    const wide: DeadlinePolicy = { timeZone: "Asia/Kuwait", hoursBefore: 30 };
    expect(stateAt("2026-11-04T14:59:59.999Z", "2026-11-05", true, wide).dueSoon).toBe(false);
    expect(stateAt("2026-11-04T15:00:00.000Z", "2026-11-05", true, wide).dueSoon).toBe(true);
  });

  it("is never due soon or overdue for a work that is done, but still has a deadline", () => {
    const state = stateAt("2026-12-30T00:00:00.000Z", "2026-11-05", false);
    expect(state.dueSoon).toBe(false);
    expect(state.overdue).toBe(false);
    expect(state.deadlineAt.toISOString()).toBe("2026-11-05T21:00:00.000Z");
  });

  it("is never both at once, for any minute around the boundaries", () => {
    const start = at("2026-11-05T11:00:00.000Z").getTime();
    for (let minute = 0; minute <= 12 * 60; minute += 7) {
      const state = stateAt(new Date(start + minute * 60_000).toISOString());
      expect(state.dueSoon && state.overdue).toBe(false);
    }
  });

  it("agrees with comparing the instant to the deadline", () => {
    const start = at("2026-11-05T10:00:00.000Z").getTime();
    for (let minute = 0; minute <= 14 * 60; minute += 11) {
      const now = new Date(start + minute * 60_000);
      const deadline = deadlineOf("2026-11-05", kuwait).getTime();
      const state = stateAt(now.toISOString());
      expect(state.overdue, now.toISOString()).toBe(now.getTime() >= deadline);
      expect(state.dueSoon, now.toISOString()).toBe(
        now.getTime() < deadline && now.getTime() >= deadline - 8 * 3_600_000,
      );
    }
  });
});

describe("deadlineState across daylight saving", () => {
  const ny: DeadlinePolicy = { timeZone: "America/New_York", hoursBefore: 8 };

  it("is overdue at the first instant of the next local day on a 23-hour day", () => {
    // 2026-03-08 has 23 hours: its end is 2026-03-09T04:00Z.
    expect(stateAt("2026-03-09T03:59:59.999Z", "2026-03-08", true, ny).overdue).toBe(false);
    expect(stateAt("2026-03-09T04:00:00.000Z", "2026-03-08", true, ny).overdue).toBe(true);
  });

  it("is overdue at the first instant of the next local day on a 25-hour day", () => {
    // 2026-11-01 has 25 hours: its end is 2026-11-02T05:00Z.
    expect(stateAt("2026-11-02T04:59:59.999Z", "2026-11-01", true, ny).overdue).toBe(false);
    expect(stateAt("2026-11-02T05:00:00.000Z", "2026-11-01", true, ny).overdue).toBe(true);
  });
});
