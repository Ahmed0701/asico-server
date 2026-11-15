import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openScratch, type ScratchDatabase } from "./scratch.js";
import { scratchHolder } from "./scratch-prisma.js";

// THE HARD TEST: the real Express app on a real HTTP port, against a real PostgreSQL (a scratch schema made for this run and
// dropped after it), attacked the way a busy team and a hostile client would:
//
//   * races: many requests at the same instant on the same row, the same Idempotency-Key, the same unique number, the same
//     file limit, a villa deleted while records are added to it;
//   * hostile input: SQL and LIKE injection, script tags, path tricks in file names, files that lie about their type, bodies
//     too big or not JSON, prototype pollution, extra fields, numbers out of range;
//   * forged access: bad signatures, tokens of deactivated users, an employee whose token claims ADMIN, one record's file
//     asked through another record;
//   * a storm of mixed writes, then every invariant checked in SQL: nothing half-written, totals equal to the sums, one
//     audit entry per write that succeeded.

const RUN = process.env.ASICO_DB_TESTS === "1";

vi.mock(
  "../../src/core/database/prisma.js",
  async () => (await import("./scratch-prisma.js")).scratchPrismaModule,
);

import { createApp } from "../../src/app.js";
import { signAccessToken } from "../../src/core/security/jwt.js";

const C1 = "00000000-0000-4000-8000-0000000000c1";
const PDF = Buffer.from("%PDF-1.7\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]);

describe.skipIf(!RUN)("the hard test (real HTTP, real PostgreSQL, scratch schema)", () => {
  let scratch: ScratchDatabase;
  let server: http.Server;
  let base: string;
  let adminToken: string;
  let employeeToken: string;
  const q = (text: string, values?: unknown[]) => scratch.q(text, values);
  const one = async (text: string, values?: unknown[]) => (await q(text, values)).rows[0];

  const call = (token = adminToken) => {
    const agent = request(base);
    const auth = (r: request.Test) => r.set("Authorization", `Bearer ${token}`).set("Accept-Language", "en");
    return {
      get: (path: string) => auth(agent.get(`/api/v1${path}`)),
      post: (path: string) => auth(agent.post(`/api/v1${path}`)),
      patch: (path: string) => auth(agent.patch(`/api/v1${path}`)),
      delete: (path: string) => auth(agent.delete(`/api/v1${path}`)),
    };
  };
  const api = () => call();

  let villaSeq = 0;
  async function newVilla(): Promise<string> {
    villaSeq += 1;
    const id = randomUUID();
    await q(
      `INSERT INTO "Villa" ("id","villaNumber","block","plot","civilEngineerId","createdById","areaId","contractorId","updatedAt")
       VALUES ($1, $2, 'B', $3, 'eng', 'admin', 'area', '00000000-0000-4000-8000-0000000000c1', now())`,
      [id, `H-${villaSeq}`, String(villaSeq)],
    );
    return id;
  }

  beforeAll(async () => {
    scratch = await openScratch("scratchhard", 3);
    scratchHolder.client = scratch.prisma as unknown as Record<string | symbol, unknown>;
    await q(
      `INSERT INTO "User" ("id","name","email","passwordHash","role","isActive","updatedAt") VALUES
       ('admin','Root','a@x.test','x','ADMIN',true,now()),
       ('emp','Employee','e@x.test','x','EMPLOYEE',true,now()),
       ('gone','Gone','g@x.test','x','EMPLOYEE',false,now())`,
    );
    await q(
      `INSERT INTO "Permission" ("id","code") VALUES (gen_random_uuid()::text, 'villas:read'), (gen_random_uuid()::text, 'villas:update') ON CONFLICT ("code") DO NOTHING`,
    );
    await q(
      `INSERT INTO "UserPermission" ("userId","permissionId") SELECT 'emp', "id" FROM "Permission" WHERE "code" IN ('villas:read','payments:read')`,
    );
    await q(`INSERT INTO "CivilEngineer" ("id","name","phone","updatedAt") VALUES ('eng','Eng','012',now())`);
    await q(`INSERT INTO "Area" ("id","name","city","updatedAt") VALUES ('area','Sabah','Kuwait',now())`);
    await q(
      `INSERT INTO "Contractor" ("id","name","phone","status","updatedAt") VALUES ('00000000-0000-4000-8000-0000000000c1','Nile Builders','0100','ACTIVE',now())`,
    );
    adminToken = await signAccessToken({ id: "admin", role: "ADMIN" });
    // An employee whose token says ADMIN: the role must come from the database, not from the token.
    employeeToken = await signAccessToken({ id: "emp", role: "ADMIN" });
    server = http.createServer(createApp()).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 180_000);

  afterAll(async () => {
    await new Promise<void>((done) => server?.close(() => done()));
    await scratch?.dispose();
  });

  // ---------------------------------------------------------------- races

  describe("races", () => {
    it("lets exactly one of 25 simultaneous edits with the same version win; the others get VERSION_CONFLICT", async () => {
      const created = await api().post("/payments").send({ contractorId: C1, amountMinor: 1000 });
      expect(created.status).toBe(201);
      const { id, version } = created.body.data as { id: string; version: number };

      const results = await Promise.all(
        Array.from({ length: 25 }, (_, i) =>
          api()
            .patch(`/payments/${id}`)
            .set("If-Match", `"${version}"`)
            .send({ amountMinor: 2000 + i }),
        ),
      );

      const ok = results.filter((res) => res.status === 200);
      expect(ok).toHaveLength(1);
      expect(
        results.filter((res) => res.status === 409).every((res) => res.body.code === "VERSION_CONFLICT"),
      ).toBe(true);
      expect(ok.length + results.filter((res) => res.status === 409).length).toBe(25);
      const row = await one(
        `SELECT "version", "amountMinor"::int AS amount FROM "ContractorPayment" WHERE "id" = $1`,
        [id],
      );
      expect(row.version).toBe(version + 1);
      expect(row.amount).toBe(ok[0]!.body.data.amountMinor);
      const audits = await one(
        `SELECT count(*)::int AS n FROM "AuditLog" WHERE "entityId" = $1 AND "action" = 'payment.update'`,
        [id],
      );
      expect(audits.n).toBe(1);
    });

    it("creates one payment for 20 simultaneous requests with the same Idempotency-Key", async () => {
      const key = randomUUID();
      const body = { contractorId: C1, amountMinor: 777_000, reference: `IDEM-${key}` };
      const results = await Promise.all(
        Array.from({ length: 20 }, () => api().post("/payments").set("Idempotency-Key", key).send(body)),
      );

      const created = results.filter((res) => res.status === 201);
      expect(created.length).toBeGreaterThanOrEqual(1);
      // Every answer is the one payment (replayed) or "still in progress"; nothing else.
      expect(new Set(created.map((res) => res.body.data.id)).size).toBe(1);
      for (const res of results) expect([201, 409]).toContain(res.status);
      const rows = await one(`SELECT count(*)::int AS n FROM "ContractorPayment" WHERE "reference" = $1`, [
        body.reference,
      ]);
      expect(rows.n).toBe(1);

      // The same key with another body is refused, and still makes nothing.
      const reused = await api()
        .post("/payments")
        .set("Idempotency-Key", key)
        .send({ ...body, amountMinor: 1 });
      expect(reused.status).toBeGreaterThanOrEqual(400);
      expect(reused.body.code).toBe("IDEMPOTENCY_KEY_REUSED");
    });

    it("keeps a VO number unique in its villa when 15 requests race for it", async () => {
      const villa = await newVilla();
      const results = await Promise.all(
        Array.from({ length: 15 }, (_, i) =>
          api()
            .post(`/villas/${villa}/variation-orders`)
            .send({ voNumber: i % 2 ? "vo-race" : "VO-RACE", amountMinor: 1000 * i }),
        ),
      );

      expect(results.filter((res) => res.status === 201)).toHaveLength(1);
      const refused = results.filter((res) => res.status !== 201);
      expect(
        refused.every((res) => res.status === 409 && res.body.code === "VARIATION_ORDER_NUMBER_TAKEN"),
      ).toBe(true);
      const rows = await one(`SELECT count(*)::int AS n FROM "VariationOrder" WHERE "villaId" = $1`, [villa]);
      expect(rows.n).toBe(1);
    });

    it("never lets simultaneous uploads pass the 10-file limit of a variation order", async () => {
      const villa = await newVilla();
      const vo = (
        await api().post(`/villas/${villa}/variation-orders`).send({ voNumber: "F", amountMinor: 1 })
      ).body.data as { id: string };

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, n) =>
          api()
            .post(`/variation-orders/${vo.id}/files`)
            .attach("file", PDF, `a${n}.pdf`)
            .attach("file", PDF, `b${n}.pdf`)
            .attach("file", PDF, `c${n}.pdf`),
        ),
      );

      const ok = results.filter((res) => res.status === 201).length;
      expect(ok).toBe(3);
      expect(results.filter((res) => res.body.code === "VARIATION_ORDER_FILE_LIMIT")).toHaveLength(2);
      const rows = await one(
        `SELECT count(*)::int AS n FROM "VariationOrderFile" WHERE "variationOrderId" = $1`,
        [vo.id],
      );
      expect(rows.n).toBe(9);
    });

    it("gives a villa one open work per phase however many are created at once", async () => {
      const villa = await newVilla();
      const phase = randomUUID();
      await q(`INSERT INTO "ElecPhase" ("id","name","sortOrder","updatedAt") VALUES ($1, $2, 990, now())`, [
        phase,
        `Race phase ${phase.slice(0, 6)}`,
      ]);
      const results = await Promise.all(
        Array.from({ length: 12 }, () =>
          api().post("/open-works").send({ villaId: villa, elecPhaseId: phase }),
        ),
      );

      expect(results.filter((res) => res.status === 201)).toHaveLength(1);
      expect(results.every((res) => res.status === 201 || res.status === 409)).toBe(true);
      const rows = await one(
        `SELECT count(*)::int AS n FROM "WorkItem" WHERE "villaId" = $1 AND "elecPhaseId" = $2`,
        [villa, phase],
      );
      expect(rows.n).toBe(1);
    });

    it("never leaves a record behind a villa deleted while records are added to it (10 rounds)", async () => {
      for (let round = 0; round < 10; round++) {
        const villa = await newVilla();
        const version = (await one(`SELECT "version" FROM "Villa" WHERE "id" = $1`, [villa]))
          .version as number;
        const [removed, vo, payment] = await Promise.all([
          api().delete(`/villas/${villa}`).set("If-Match", `"${version}"`),
          api()
            .post(`/villas/${villa}/variation-orders`)
            .send({ voNumber: `R${round}`, amountMinor: 5 }),
          api().post("/payments").send({ contractorId: C1, villaId: villa, amountMinor: 5 }),
        ]);

        // No server error, whatever the order.
        for (const res of [removed, vo, payment])
          expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
        const exists = (await one(`SELECT count(*)::int AS n FROM "Villa" WHERE "id" = $1`, [villa])).n === 1;
        if (!exists) {
          expect(vo.status).not.toBe(201);
          expect(payment.status).not.toBe(201);
        }
        if (vo.status === 201 || payment.status === 201) expect(exists).toBe(true);
      }
      const orphans = await one(
        `SELECT (SELECT count(*) FROM "VariationOrder" o LEFT JOIN "Villa" v ON v."id" = o."villaId" WHERE v."id" IS NULL)
              + (SELECT count(*) FROM "ContractorPayment" p LEFT JOIN "Villa" v ON v."id" = p."villaId" WHERE p."villaId" IS NOT NULL AND v."id" IS NULL) AS n`,
      );
      expect(Number(orphans.n)).toBe(0);
    });

    it("refuses MEW inspection while a VO is pending, and allows it the moment the last one is paid", async () => {
      const villa = await newVilla();
      await q(`UPDATE "Villa" SET "mewAcState" = 'APPROVED', "mewElecState" = 'APPROVED' WHERE "id" = $1`, [
        villa,
      ]);
      const vos = await Promise.all(
        ["A", "B", "C"].map(
          async (n) =>
            (await api().post(`/villas/${villa}/variation-orders`).send({ voNumber: n, amountMinor: 1 })).body
              .data as {
              id: string;
              version: number;
            },
        ),
      );
      const refused = await api().post(`/villas/${villa}/mew-inspection`);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe("VILLA_VARIATION_ORDERS_PENDING");
      expect(refused.body.details[0].value).toBe(3);

      await Promise.all(
        vos.map((vo) =>
          api()
            .patch(`/variation-orders/${vo.id}`)
            .set("If-Match", `"${vo.version}"`)
            .send({ status: "PAID" }),
        ),
      );
      expect((await api().post(`/villas/${villa}/mew-inspection`)).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------- hostile input

  describe("hostile input", () => {
    const nasty = [
      "' OR 1=1 --",
      `%'; DROP TABLE "Villa"; --`,
      "\\",
      "%",
      "_",
      "\u0000",
      "<script>alert(1)</script>",
      "فيلا 😀",
      "a".repeat(100),
    ];

    it("answers every list search with injection strings safely, and drops nothing", async () => {
      const before = (await one(`SELECT count(*)::int AS n FROM "Villa"`)).n;
      for (const term of nasty) {
        for (const path of [
          "/villas",
          "/payments",
          "/open-works",
          "/owner-notes",
          "/monthly-progress",
          "/contractors",
        ]) {
          const res = await api().get(`${path}?search=${encodeURIComponent(term)}`);
          expect([200, 400], `${path} ${JSON.stringify(term)}: ${res.status}`).toContain(res.status);
        }
      }
      // A NUL character is refused up front (PostgreSQL text cannot hold one), on a query and in a body.
      const nulQuery = await api().get("/villas?search=a%00b");
      expect(nulQuery.status).toBe(400);
      expect(nulQuery.body.code).toBe("VALIDATION_ERROR");
      const nulVilla = await newVilla();
      const nulBody = await api()
        .post(`/villas/${nulVilla}/variation-orders`)
        .send({ voNumber: "N\u0000", amountMinor: 1 });
      expect(nulBody.status).toBe(400);
      // "%" and "_" are taken literally: they match no villa number here.
      expect((await api().get("/villas?search=%25")).body.meta.total).toBe(0);
      expect((await api().get("/villas?search=_")).body.meta.total).toBe(0);
      // One villa more: the one the NUL body check above made, nothing dropped.
      expect((await one(`SELECT count(*)::int AS n FROM "Villa"`)).n).toBe(before + 1);
    });

    it("stores script tags and Arabic as text and gives them back as JSON, never as HTML", async () => {
      const villa = await newVilla();
      const notes = `<img src=x onerror=alert(1)> ملاحظة "quoted" 'single' ‮evil`;
      const res = await api()
        .post(`/villas/${villa}/variation-orders`)
        .send({ voNumber: "<b>X</b>", amountMinor: 1, notes });
      expect(res.status).toBe(201);
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.body.data.notes).toBe(notes);
      expect(res.body.data.voNumber).toBe("<b>X</b>");
    });

    it("cleans path tricks out of file names and refuses files that lie about their type", async () => {
      const villa = await newVilla();
      const vo = (
        await api().post(`/villas/${villa}/variation-orders`).send({ voNumber: "P", amountMinor: 1 })
      ).body.data as { id: string };

      const tricky = await api()
        .post(`/variation-orders/${vo.id}/files`)
        .attach("file", PDF, "../../../etc/passwd.pdf");
      expect(tricky.status).toBe(201);
      const name = tricky.body.data.files[0].name as string;
      expect(name).not.toMatch(/[\\/]/);
      expect(name.endsWith(".pdf")).toBe(true);
      const key = (await one(`SELECT "key" FROM "VariationOrderFile" WHERE "variationOrderId" = $1`, [vo.id]))
        .key as string;
      expect(key).toMatch(new RegExp(`^variation-orders/${vo.id}/[0-9a-f-]{36}\\.pdf$`));

      for (const [bytes, filename, type] of [
        [PNG, "photo.pdf", "application/pdf"],
        [EXE, "invoice.pdf", "application/pdf"],
        [Buffer.from("just text"), "notes.pdf", "application/pdf"],
      ] as const) {
        const res = await api()
          .post(`/variation-orders/${vo.id}/files`)
          .attach("file", bytes, { filename, contentType: type });
        expect(res.status, filename).toBe(400);
        expect(res.body.code).toBe("INVALID_FILE_TYPE");
      }
      expect(
        (
          await one(`SELECT count(*)::int AS n FROM "VariationOrderFile" WHERE "variationOrderId" = $1`, [
            vo.id,
          ])
        ).n,
      ).toBe(1);
    });

    it("refuses bodies that are too big, not JSON, polluted or carrying fields of their own", async () => {
      const villa = await newVilla();
      const huge = await api()
        .post(`/villas/${villa}/variation-orders`)
        .send({ voNumber: "H", amountMinor: 1, notes: "x".repeat(3 * 1024 * 1024) });
      expect(huge.status).toBe(413);

      const broken = await api()
        .post(`/villas/${villa}/variation-orders`)
        .set("Content-Type", "application/json")
        .send('{"voNumber": "B", "amountMinor": ');
      expect(broken.status).toBe(400);

      const polluted = await api()
        .post(`/villas/${villa}/variation-orders`)
        .set("Content-Type", "application/json")
        .send(
          '{"voNumber":"Q","amountMinor":1,"__proto__":{"role":"ADMIN"},"constructor":{"prototype":{"x":1}}}',
        );
      expect(polluted.status).toBe(400);
      expect(({} as Record<string, unknown>).role).toBeUndefined();

      for (const extra of [
        { id: randomUUID() },
        { version: 99 },
        { villaId: randomUUID() },
        { createdAt: "2020-01-01" },
      ]) {
        const res = await api()
          .post(`/villas/${villa}/variation-orders`)
          .send({ voNumber: `E${Object.keys(extra)[0]}`, amountMinor: 1, ...extra });
        expect(res.status, JSON.stringify(extra)).toBe(400);
      }
      expect(
        (await one(`SELECT count(*)::int AS n FROM "VariationOrder" WHERE "villaId" = $1`, [villa])).n,
      ).toBe(0);
    });

    it("refuses numbers and pages out of range instead of clamping them", async () => {
      const villa = await newVilla();
      for (const amountMinor of [1e20, -1, 1.5, "100", null, Number.MAX_SAFE_INTEGER + 2]) {
        const res = await api()
          .post(`/villas/${villa}/variation-orders`)
          .send({ voNumber: "N", amountMinor });
        expect(res.status, String(amountMinor)).toBe(400);
      }
      for (const query of ["limit=1001", "limit=0", "page=0", "page=-1", "limit=abc"]) {
        expect((await api().get(`/payments?${query}`)).status, query).toBe(400);
      }
      expect((await api().get("/monthly-progress?month=9999-12")).body.code).toBe("MONTH_IN_FUTURE");
      const old = await api().get("/monthly-progress?month=1990-01");
      expect(old.status).toBe(200);
      expect(old.body.data).toEqual([]);
    });
  });

  // ---------------------------------------------------------------- forged access

  describe("forged access", () => {
    it("refuses a token with a bad signature, a token of a deactivated user, and none at all", async () => {
      const [head, body, sig] = adminToken.split(".");
      const flipped = `${head}.${body}.${sig!.slice(0, -2)}${sig!.endsWith("A") ? "B" : "A"}A`;
      expect((await call(flipped).get("/villas")).status).toBe(401);
      const forgedBody = Buffer.from(JSON.stringify({ sub: "admin", role: "ADMIN" })).toString("base64url");
      expect((await call(`${head}.${forgedBody}.${sig}`).get("/villas")).status).toBe(401);
      expect((await call(`${head}.${body}.`).get("/villas")).status).toBe(401);
      expect((await call(await signAccessToken({ id: "gone", role: "ADMIN" })).get("/villas")).status).toBe(
        401,
      );
      expect((await call(await signAccessToken({ id: "nobody", role: "ADMIN" })).get("/villas")).status).toBe(
        401,
      );
      expect((await request(base).get("/api/v1/villas")).status).toBe(401);
    });

    it("takes the role from the database: an employee whose token claims ADMIN keeps only its own permissions", async () => {
      const emp = call(employeeToken);
      expect((await emp.get("/villas")).status).toBe(200);
      expect((await emp.get("/payments")).status).toBe(200);
      expect((await emp.post("/payments").send({ contractorId: C1, amountMinor: 1 })).status).toBe(403);
      expect((await emp.get("/users")).status).toBe(403);
      expect((await emp.get("/audit-logs")).status).toBe(403);
      const villa = await newVilla();
      expect(
        (await emp.post(`/villas/${villa}/variation-orders`).send({ voNumber: "Z", amountMinor: 1 })).status,
      ).toBe(403);
    });

    it("never gives a file through another record's id", async () => {
      const [v1, v2] = [await newVilla(), await newVilla()];
      const a = (await api().post(`/villas/${v1}/variation-orders`).send({ voNumber: "A", amountMinor: 1 }))
        .body.data;
      const b = (await api().post(`/villas/${v2}/variation-orders`).send({ voNumber: "B", amountMinor: 1 }))
        .body.data;
      const withFile = await api().post(`/variation-orders/${a.id}/files`).attach("file", PDF, "a.pdf");
      const fileId = withFile.body.data.files[0].id as string;

      expect((await api().get(`/variation-orders/${a.id}/files/${fileId}`)).status).toBe(200);
      expect((await api().get(`/variation-orders/${b.id}/files/${fileId}`)).status).toBe(404);
      expect((await api().delete(`/variation-orders/${b.id}/files/${fileId}`)).status).toBe(404);
      expect(
        (await one(`SELECT count(*)::int AS n FROM "VariationOrderFile" WHERE "id" = $1`, [fileId])).n,
      ).toBe(1);
    });
  });

  // ---------------------------------------------------------------- the storm

  it("survives a storm of 300 mixed writes, and every invariant holds afterwards", async () => {
    const villas = await Promise.all(Array.from({ length: 6 }, () => newVilla()));
    const auditBefore = (await one(`SELECT count(*)::int AS n FROM "AuditLog"`)).n as number;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

    const op = async (i: number): Promise<number> => {
      const kind = i % 6;
      if (kind === 0 || kind === 1) {
        const res = await api()
          .post("/payments")
          .send({
            contractorId: C1,
            villaId: pick(villas),
            amountMinor: 1000 + i,
            status: i % 4 ? "PENDING" : "PAID",
          });
        return res.status;
      }
      if (kind === 2) {
        const res = await api()
          .post(`/villas/${pick(villas)}/variation-orders`)
          .send({ voNumber: `S-${i % 40}`, amountMinor: 100 * i, status: i % 3 ? "PENDING" : "PAID" });
        return res.status;
      }
      // Edits and deletes of whatever is there now, with the version read a moment ago (often stale by then).
      const table = kind === 5 ? "VariationOrder" : "ContractorPayment";
      const row = (await q(`SELECT "id", "version" FROM "${table}" ORDER BY random() LIMIT 1`)).rows[0];
      if (!row) return 0;
      const path = table === "VariationOrder" ? `/variation-orders/${row.id}` : `/payments/${row.id}`;
      if (kind === 3) {
        return (await api().delete(path).set("If-Match", `"${row.version}"`)).status;
      }
      return (
        await api()
          .patch(path)
          .set("If-Match", `"${row.version}"`)
          .send({ status: i % 2 ? "PAID" : "PENDING" })
      ).status;
    };

    const statuses: number[] = [];
    // 300 operations, 30 at a time.
    for (let batch = 0; batch < 10; batch++) {
      statuses.push(...(await Promise.all(Array.from({ length: 30 }, (_, j) => op(batch * 30 + j)))));
    }

    expect(
      statuses.filter((status) => status >= 500),
      "no server error",
    ).toEqual([]);
    for (const status of statuses) expect([0, 200, 201, 204, 404, 409]).toContain(status);
    const wins = statuses.filter((status) => status === 200 || status === 201 || status === 204).length;

    // One audit entry for every write that succeeded, no more, no fewer.
    const auditAfter = (await one(`SELECT count(*)::int AS n FROM "AuditLog"`)).n as number;
    expect(auditAfter - auditBefore).toBe(wins);

    // The rules the database and the service keep: paid has its date, pending has none, no negative amount, VO numbers
    // unique per villa ignoring case, versions never below 1.
    const broken = await one(
      `SELECT
         (SELECT count(*) FROM "ContractorPayment" WHERE ("status" = 'PAID' AND "paidDate" IS NULL) OR ("status" = 'PENDING' AND "paidDate" IS NOT NULL) OR "amountMinor" < 0 OR "version" < 1)
       + (SELECT count(*) FROM (SELECT "villaId", lower("voNumber") FROM "VariationOrder" GROUP BY 1, 2 HAVING count(*) > 1) d)
       + (SELECT count(*) FROM "VariationOrder" WHERE "amountMinor" < 0 OR "version" < 1) AS n`,
    );
    expect(Number(broken.n)).toBe(0);

    // The totals the pages show are the sums in the database.
    const listed = await api().get("/payments?limit=1");
    const sums = await one(
      `SELECT coalesce(sum("amountMinor") FILTER (WHERE "status" = 'PENDING'), 0)::bigint AS pending,
              coalesce(sum("amountMinor") FILTER (WHERE "status" = 'PAID'), 0)::bigint AS paid FROM "ContractorPayment"`,
    );
    expect(listed.body.totals.pendingMinor).toBe(Number(sums.pending));
    expect(listed.body.totals.paidMinor).toBe(Number(sums.paid));
    for (const villa of villas) {
      const vo = await api().get(`/villas/${villa}/variation-orders`);
      const dbSums = await one(
        `SELECT coalesce(sum("amountMinor") FILTER (WHERE "status" = 'PENDING'), 0)::bigint AS pending,
                coalesce(sum("amountMinor") FILTER (WHERE "status" = 'PAID'), 0)::bigint AS paid
         FROM "VariationOrder" WHERE "villaId" = $1`,
        [villa],
      );
      expect(vo.body.totals).toEqual({
        pendingMinor: Number(dbSums.pending),
        paidMinor: Number(dbSums.paid),
      });
      expect(vo.body.data).toHaveLength(
        (await one(`SELECT count(*)::int AS n FROM "VariationOrder" WHERE "villaId" = $1`, [villa])).n,
      );
    }
  }, 300_000);
});
