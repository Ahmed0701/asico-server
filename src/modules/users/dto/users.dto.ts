import type { Role } from "../../../generated/prisma/client.js";
import type { PageMeta } from "../../../shared/query/pagination.js";
import type { MeDto, UserDto } from "../../auth/dto/auth.dto.js";

export type { MeDto, UserDto };

// Columns a client may sort by. The validator, the service and the repository all use this list.
export const USER_SORT_FIELDS = ["name", "email", "createdAt", "role"] as const;
export type UserSortField = (typeof USER_SORT_FIELDS)[number];

export function isUserSortField(value: string): value is UserSortField {
  return (USER_SORT_FIELDS as readonly string[]).includes(value);
}

export type UserSort = { field: UserSortField; direction: "asc" | "desc" };

export type UserFilters = {
  role?: Role | undefined;
  isActive?: boolean | undefined;
  search?: string | undefined;
};

export type UserListResult = { users: UserDto[]; meta: PageMeta };
