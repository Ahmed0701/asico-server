import bcrypt from "bcrypt";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { BCRYPT_COST } from "../../shared/constants/security.js";

// bcrypt ignores everything after 72 bytes, so longer passwords are rejected rather than truncated.
const adminConfigSchema = z.object({
  ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email()),
  ADMIN_PASSWORD: z
    .string()
    .min(12)
    .refine((value) => Buffer.byteLength(value) <= 72, "must be at most 72 bytes"),
});

export type AdminSeedResult = "created" | "exists";

// ADMIN permissions are implied by the role, so no UserPermission rows are created.
export async function ensureAdmin(
  db: Pick<PrismaClient, "user">,
  source: Record<string, string | undefined>,
): Promise<AdminSeedResult> {
  if (await db.user.findFirst({ where: { role: "ADMIN" }, select: { id: true } })) {
    return "exists";
  }

  const parsed = adminConfigSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`No admin exists; set valid ADMIN_EMAIL and ADMIN_PASSWORD (${problems.join("; ")})`);
  }
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: password } = parsed.data;

  if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new Error("A non-admin user already uses ADMIN_EMAIL; choose another email");
  }

  await db.user.create({
    data: {
      name: "Administrator",
      email,
      passwordHash: await bcrypt.hash(password, BCRYPT_COST),
      role: "ADMIN",
      isActive: true,
    },
  });
  return "created";
}
