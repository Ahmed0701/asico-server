import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { store } from "../auth/in-memory-auth.repository.js";

vi.mock("../../../src/core/database/prisma.js", async () => ({
  prisma: (await import("../auth/in-memory-auth.repository.js")).fakePrisma,
}));

import { createApp } from "../../../src/app.js";
import { signAccessToken } from "../../../src/core/security/jwt.js";
import type { User } from "../../../src/generated/prisma/client.js";

// Who may see, add and remove a villa's site images (the villa documents' permissions), and what the routes take. The
// images themselves are tested on a real database (tests/db/villa-images.db.test.ts).
const app = createApp();
const VILLA = randomUUID();
const IMAGE = randomUUID();

let admin: User;
beforeEach(() => {
  store.reset();
  admin = store.addUser({ name: "Root Admin", email: "root@example.test", passwordHash: "x", role: "ADMIN" });
});

const token = async (user: User) => `Bearer ${await signAccessToken({ id: user.id, role: user.role })}`;
function employee(...codes: string[]): User {
  const user = store.addUser({ name: "E", email: `e${randomUUID()}@example.test`, passwordHash: "x" });
  store.grant(user.id, ...codes);
  return user;
}

describe("villa site images", () => {
  it.each([
    ["get", `/api/v1/villas/${VILLA}/images`, "villa-documents:download"],
    ["get", `/api/v1/villa-images/${IMAGE}/file`, "villa-documents:download"],
    ["post", `/api/v1/villas/${VILLA}/images`, "villa-documents:upload"],
    ["delete", `/api/v1/villa-images/${IMAGE}`, "villa-documents:delete"],
  ] as const)("%s %s needs %s and a token", async (method, path, code) => {
    expect((await request(app)[method](path)).status).toBe(401);
    const other = await token(employee("villas:read", "villas:update"));
    expect((await request(app)[method](path).set("Authorization", other)).status).toBe(403);
    const allowed = await token(employee(code));
    expect((await request(app)[method](path).set("Authorization", allowed)).status).not.toBe(403);
  });

  it("refuses ids that are not UUIDs and an upload with no file", async () => {
    const auth = await token(admin);
    expect((await request(app).get("/api/v1/villas/V-1/images").set("Authorization", auth)).status).toBe(400);
    expect((await request(app).delete("/api/v1/villa-images/abc").set("Authorization", auth)).status).toBe(
      400,
    );
    const empty = await request(app).post(`/api/v1/villas/${VILLA}/images`).set("Authorization", auth);
    expect(empty.status).toBe(400);
  });
});
