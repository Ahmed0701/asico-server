import { z } from "zod";
import { Role } from "../../../generated/prisma/client.js";
import { paginationQuerySchema } from "../../../shared/query/pagination.js";
import { email, name, newPassword, permissionCodes } from "../../../shared/validation/fields.js";
import { USER_SORT_FIELDS } from "../dto/users.dto.js";

// "name", "name:asc" or "name:desc", for the whitelisted fields only. Anything else is a 400, not ignored.
const sortPattern = new RegExp(`^(${USER_SORT_FIELDS.join("|")})(:(asc|desc))?$`);

export const listUsersQuerySchema = paginationQuerySchema.extend({
  sort: z.string().regex(sortPattern, { error: "validation.sortInvalid" }).optional(),
  role: z.enum(Role, { error: "validation.roleInvalid" }).optional(),
  isActive: z
    .enum(["true", "false"], { error: "validation.booleanInvalid" })
    .transform((value) => value === "true")
    .optional(),
  search: z.string().trim().max(100, { error: "validation.searchTooLong" }).optional(),
});

// The role is never accepted: users created here are always EMPLOYEE.
export const createUserSchema = z.strictObject({
  name,
  email,
  password: newPassword,
  isActive: z.boolean({ error: "validation.booleanInvalid" }).default(true),
  permissions: permissionCodes.default([]),
});

export const updateUserSchema = z
  .strictObject({ name: name.optional(), email: email.optional() })
  .refine((value) => value.name !== undefined || value.email !== undefined, {
    error: "validation.atLeastOneField",
  });

export type ListUsersQuery = z.output<typeof listUsersQuerySchema>;
export type CreateUserInput = z.output<typeof createUserSchema>;
export type UpdateUserInput = z.output<typeof updateUserSchema>;
