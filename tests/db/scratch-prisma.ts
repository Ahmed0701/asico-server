// Stands in for src/core/database/prisma.js in the tests that use a scratch schema: `prisma` forwards to whichever client
// the test puts in `scratchHolder` (set in beforeAll, once the schema exists). Used as:
//   vi.mock("../../src/core/database/prisma.js", async () => (await import("./scratch-prisma.js")).scratchPrismaModule);
export const scratchHolder: { client: Record<string | symbol, unknown> | null } = { client: null };

export const scratchPrismaModule = {
  prisma: new Proxy(
    {},
    {
      get(_target, property) {
        const client = scratchHolder.client;
        if (!client) throw new Error("the scratch Prisma client is not ready");
        const value = client[property];
        return typeof value === "function" ? value.bind(client) : value;
      },
    },
  ),
};
