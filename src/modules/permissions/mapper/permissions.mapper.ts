import type { PermissionGroupDto, UserPermissionsDto } from "../dto/permissions.dto.js";

// "villas:read" belongs to the "villas" resource. Resources and codes are returned sorted.
export function toPermissionGroups(codes: readonly string[]): PermissionGroupDto[] {
  const byResource = new Map<string, string[]>();
  for (const code of [...codes].sort()) {
    const resource = code.split(":")[0] ?? code;
    byResource.set(resource, [...(byResource.get(resource) ?? []), code]);
  }
  return [...byResource.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([resource, permissions]) => ({ resource, permissions }));
}

export function toUserPermissionsDto(userId: string, codes: readonly string[]): UserPermissionsDto {
  return { userId, permissions: [...codes] };
}
