import { describe, expect, it } from "vitest";
import {
  foreignKeyConstraint,
  isForeignKeyViolation,
  isRecordNotFound,
  uniqueViolationConstraint,
} from "../../src/shared/utils/index.js";

const withCode = (code: unknown): Error => Object.assign(new Error("x"), { code });

describe("Prisma error helpers", () => {
  it("recognise a foreign key violation (P2003) and nothing else", () => {
    expect(isForeignKeyViolation(withCode("P2003"))).toBe(true);
    expect(isForeignKeyViolation(withCode("P2025"))).toBe(false);
    expect(isForeignKeyViolation(withCode("P2002"))).toBe(false);
  });

  it("recognise a missing record (P2025) and nothing else", () => {
    expect(isRecordNotFound(withCode("P2025"))).toBe(true);
    expect(isRecordNotFound(withCode("P2003"))).toBe(false);
  });

  it.each([undefined, null, "P2003", 42, {}, new Error("plain"), withCode(2003), withCode(undefined)])(
    "are false for anything that is not an error carrying a string code (%j)",
    (value) => {
      expect(isForeignKeyViolation(value)).toBe(false);
      expect(isRecordNotFound(value)).toBe(false);
    },
  );
});

describe("constraint helpers", () => {
  const adapterError = (code: string, constraint: unknown): Error =>
    Object.assign(new Error("x"), { code, meta: { driverAdapterError: { cause: { constraint } } } });

  it("read the constraint name the pg driver adapter reports", () => {
    expect(uniqueViolationConstraint(adapterError("P2002", { index: "Villa_villaNumber_key" }))).toBe(
      "Villa_villaNumber_key",
    );
    expect(foreignKeyConstraint(adapterError("P2003", { index: "Villa_civilEngineerId_fkey" }))).toBe(
      "Villa_civilEngineerId_fkey",
    );
  });

  it("join a list of fields, and fall back to meta.target", () => {
    expect(uniqueViolationConstraint(adapterError("P2002", { fields: ["area", "block", "plot"] }))).toBe(
      "area_block_plot",
    );
    expect(
      uniqueViolationConstraint(
        Object.assign(new Error("x"), { code: "P2002", meta: { target: ["email"] } }),
      ),
    ).toBe("email");
    expect(
      uniqueViolationConstraint(
        Object.assign(new Error("x"), { code: "P2002", meta: { target: "User_email_key" } }),
      ),
    ).toBe("User_email_key");
  });

  it("return an empty name when the error has no detail, and undefined for other errors", () => {
    expect(uniqueViolationConstraint(withCode("P2002"))).toBe("");
    expect(foreignKeyConstraint(withCode("P2003"))).toBe("");
    expect(uniqueViolationConstraint(withCode("P2003"))).toBeUndefined();
    expect(foreignKeyConstraint(withCode("P2002"))).toBeUndefined();
    for (const value of [undefined, null, "P2002", {}, new Error("plain")]) {
      expect(uniqueViolationConstraint(value)).toBeUndefined();
      expect(foreignKeyConstraint(value)).toBeUndefined();
    }
  });
});
