import { describe, expect, it } from "vitest";
import { denyEngineerScope } from "../../src/core/middleware/denyEngineerScope.js";
import { runWithVillaScope } from "../../src/core/scope/villa-scope.js";

// The villa's budget and the Monthly Payments are never shown to a user linked to an electrical engineer, whatever it was granted.
const pass = (locale: string, scoped: boolean) =>
  new Promise<unknown>((resolve) => {
    const run = () => denyEngineerScope({ locale } as never, {} as never, resolve);
    if (scoped) runWithVillaScope({ engineerId: "e1" }, run);
    else run();
  });

describe("denyEngineerScope", () => {
  it("refuses a linked engineer with 403 FORBIDDEN, in its language", async () => {
    expect(await pass("en", true)).toMatchObject({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "An electrical engineer cannot see villa budgets or the monthly payments",
    });
    expect(await pass("ar", true)).toMatchObject({
      message: "مهندس الكهرباء لا يمكنه رؤية ميزانيات الفلل أو المدفوعات الشهرية",
    });
  });

  it("lets anyone else on (an ADMIN, a user not linked)", async () => {
    expect(await pass("en", false)).toBeUndefined();
  });
});
