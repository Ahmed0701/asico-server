import type { User } from "../../../generated/prisma/client.js";
import type { MeDto, UserDto } from "../dto/auth.dto.js";

type UserFields = Pick<User, "id" | "name" | "email" | "role" | "isActive" | "version" | "createdAt">;

// Picks fields explicitly so passwordHash can never leak into a response.
export function toUserDto(user: UserFields): UserDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    version: user.version,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toMeDto(user: UserFields, permissions: readonly string[]): MeDto {
  return { ...toUserDto(user), permissions: [...permissions] };
}
