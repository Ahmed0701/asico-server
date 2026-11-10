import { describe, expect, it, vi } from "vitest";
import {
  CivilEngineersRepository,
  type Db as CivilDb,
} from "../../../src/modules/civil-engineers/repository/civil-engineers.repository.js";
import {
  ContractorsRepository,
  type Db as ContractorDb,
} from "../../../src/modules/contractors/repository/contractors.repository.js";
import {
  ElectricalEngineersRepository,
  type Db as ElectricalDb,
} from "../../../src/modules/electrical-engineers/repository/electrical-engineers.repository.js";

// The repositories are the only place that turns a status filter, a search and the options rule into a query. The
// in-memory fakes used by the route tests re-implement that logic, so these tests pin the real queries.

type Delegate = {
  findMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
  findUnique: ReturnType<typeof vi.fn>;
};

const delegate = (): Delegate => ({
  findMany: vi.fn().mockResolvedValue([]),
  count: vi.fn().mockResolvedValue(0),
  create: vi.fn().mockResolvedValue({}),
  updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  findUnique: vi.fn().mockResolvedValue({}),
});

type Case = {
  name: string;
  model: "civilEngineer" | "electricalEngineer" | "contractor";
  repository: {
    list: (params: unknown, db: never) => Promise<unknown>;
    options: (db: never) => Promise<unknown>;
    create: (data: unknown, db: never) => Promise<unknown>;
    update: (id: string, version: number, data: unknown, db: never) => Promise<unknown>;
  };
};

const cases: Case[] = [
  {
    name: "civil engineers",
    model: "civilEngineer",
    repository: new CivilEngineersRepository() as unknown as Case["repository"],
  },
  {
    name: "electrical engineers",
    model: "electricalEngineer",
    repository: new ElectricalEngineersRepository() as unknown as Case["repository"],
  },
  {
    name: "contractors",
    model: "contractor",
    repository: new ContractorsRepository() as unknown as Case["repository"],
  },
];

// The Db types differ per module but all are "a client with this delegate", so one stand-in serves the three.
const dbOf = (model: Case["model"], d: Delegate) =>
  ({ [model]: d }) as unknown as CivilDb & ContractorDb & ElectricalDb;

const page = { sort: { field: "name", direction: "asc" }, skip: 0, take: 20 };

describe.each(cases)("$name repository", ({ model, repository }) => {
  it("lists every status when no filter is given, and filters by exactly the status that is", async () => {
    const d = delegate();
    const db = dbOf(model, d);

    await repository.list({ ...page }, db as never);
    await repository.list({ ...page, status: "INACTIVE" }, db as never);
    await repository.list({ ...page, status: "ACTIVE" }, db as never);

    const wheres = d.findMany.mock.calls.map((call) => call[0].where);
    expect(wheres).toEqual([{}, { status: "INACTIVE" }, { status: "ACTIVE" }]);
    expect(d.count.mock.calls.map((call) => call[0].where)).toEqual(wheres);
  });

  it("searches the name, the phone and the email, case-insensitively, with LIKE characters escaped", async () => {
    const d = delegate();

    await repository.list({ ...page, search: "50%_a" }, dbOf(model, d) as never);

    expect(d.findMany.mock.calls[0]?.[0].where).toEqual({
      OR: [
        { name: { contains: expect.stringContaining("50"), mode: "insensitive" } },
        { phone: { contains: expect.stringContaining("50"), mode: "insensitive" } },
        { email: { contains: expect.stringContaining("50"), mode: "insensitive" } },
      ],
    });
    const terms = d.findMany.mock.calls[0]?.[0].where.OR.map(
      (clause: Record<string, { contains: string }>) => Object.values(clause)[0]?.contains,
    );
    expect(new Set(terms).size).toBe(1);
    expect(terms[0]).not.toBe("50%_a");
  });

  it("combines the status filter with the search", async () => {
    const d = delegate();

    await repository.list({ ...page, status: "ACTIVE", search: "x@y.test" }, dbOf(model, d) as never);

    const where = d.findMany.mock.calls[0]?.[0].where;
    expect(where.status).toBe("ACTIVE");
    expect(where.OR).toHaveLength(3);
  });

  it("selects the email and the status", async () => {
    const d = delegate();

    await repository.list({ ...page }, dbOf(model, d) as never);

    expect(d.findMany.mock.calls[0]?.[0].select).toMatchObject({ email: true, status: true });
  });

  it("offers only the ACTIVE records as options, selecting nothing but id and name", async () => {
    const d = delegate();

    await repository.options(dbOf(model, d) as never);

    const args = d.findMany.mock.calls[0]?.[0];
    expect(args.where).toEqual({ status: "ACTIVE" });
    expect(args.select).toEqual({ id: true, name: true });
    expect(args.take).toBe(1000);
  });

  it("writes the email and the status it is given, a null email included", async () => {
    const d = delegate();
    const db = dbOf(model, d) as never;

    await repository.create({ name: "N", phone: "12345", email: null, status: "ACTIVE" }, db);
    await repository.update("id-1", 4, { email: null, status: "INACTIVE" }, db);

    expect(d.create.mock.calls[0]?.[0].data).toEqual({
      name: "N",
      phone: "12345",
      email: null,
      status: "ACTIVE",
    });
    expect(d.updateMany.mock.calls[0]?.[0]).toEqual({
      where: { id: "id-1", version: 4 },
      data: { email: null, status: "INACTIVE", version: { increment: 1 } },
    });
  });
});
