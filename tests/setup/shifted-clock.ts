// OPT-IN: run the whole suite as if it were another moment, to prove that no test depends on the real time of day.
//
//   ASICO_TEST_NOW=2026-06-15T22:30:00Z npm test
//
// The clock still ticks (it is the real clock plus a fixed offset, taken once when the file starts), so code that waits or
// measures a duration behaves as usual; only "what time is it" changes. With the variable unset this file does nothing.
// Only `Date` is shifted. Timers and the database's own now() are the machine's (the unit suite has no database).
const target = process.env["ASICO_TEST_NOW"];

if (target !== undefined && target !== "") {
  const start = Date.parse(target);
  if (Number.isNaN(start)) {
    throw new Error(`ASICO_TEST_NOW is not a date: ${target}`);
  }
  const RealDate = Date;
  const offset = start - RealDate.now();

  class ShiftedDate extends RealDate {
    constructor(...args: unknown[]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      super(...((args.length === 0 ? [RealDate.now() + offset] : args) as [any]));
    }
    static override now(): number {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate as DateConstructor;
}
