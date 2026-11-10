export type PermissionGroupDto = {
  resource: string;
  permissions: string[];
};

export type UserPermissionsDto = {
  userId: string;
  permissions: string[];
};
