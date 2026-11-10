export const PERMISSIONS = {
  VILLAS_READ: "villas:read",
  VILLAS_DETAIL: "villas:detail",
  VILLAS_CREATE: "villas:create",
  VILLAS_UPDATE: "villas:update",
  VILLAS_DELETE: "villas:delete",
  VILLAS_EXPORT: "villas:export",
  // Setting how far a phase of a villa has got.
  VILLAS_PROGRESS: "villas:progress",
  // The MEW follow-up, MEW inspection and passed marks, and the villa's MEW states.
  VILLAS_INSPECTION: "villas:inspection",
  // Loading villas from a spreadsheet. Also opens the import template.
  VILLAS_IMPORT: "villas:import",

  // The list and one item are both :read. :import also opens the import template.
  OPEN_WORKS_READ: "open-works:read",
  OPEN_WORKS_CREATE: "open-works:create",
  OPEN_WORKS_UPDATE: "open-works:update",
  OPEN_WORKS_DELETE: "open-works:delete",
  OPEN_WORKS_EXPORT: "open-works:export",
  OPEN_WORKS_IMPORT: "open-works:import",

  // The list and one report are both :read. :import also opens the import template.
  DAILY_REPORTS_READ: "daily-reports:read",
  DAILY_REPORTS_CREATE: "daily-reports:create",
  DAILY_REPORTS_UPDATE: "daily-reports:update",
  DAILY_REPORTS_DELETE: "daily-reports:delete",
  DAILY_REPORTS_EXPORT: "daily-reports:export",
  DAILY_REPORTS_IMPORT: "daily-reports:import",

  // The list and one small work are both :read. :import also opens the import template.
  SMALL_WORKS_READ: "small-works:read",
  SMALL_WORKS_CREATE: "small-works:create",
  SMALL_WORKS_UPDATE: "small-works:update",
  SMALL_WORKS_DELETE: "small-works:delete",
  SMALL_WORKS_EXPORT: "small-works:export",
  SMALL_WORKS_IMPORT: "small-works:import",

  // The list and one site report are both :read. :import also opens the import template.
  SITE_REPORTS_READ: "site-reports:read",
  SITE_REPORTS_CREATE: "site-reports:create",
  SITE_REPORTS_UPDATE: "site-reports:update",
  SITE_REPORTS_DELETE: "site-reports:delete",
  SITE_REPORTS_EXPORT: "site-reports:export",
  SITE_REPORTS_IMPORT: "site-reports:import",

  // The list and one labour row are both :read. :import also opens the import template.
  DAILY_LABOUR_READ: "daily-labour:read",
  DAILY_LABOUR_CREATE: "daily-labour:create",
  DAILY_LABOUR_UPDATE: "daily-labour:update",
  DAILY_LABOUR_DELETE: "daily-labour:delete",
  DAILY_LABOUR_EXPORT: "daily-labour:export",
  DAILY_LABOUR_IMPORT: "daily-labour:import",

  CIVIL_ENGINEERS_READ: "civil-engineers:read",
  CIVIL_ENGINEERS_CREATE: "civil-engineers:create",
  CIVIL_ENGINEERS_UPDATE: "civil-engineers:update",
  CIVIL_ENGINEERS_DELETE: "civil-engineers:delete",

  ELECTRICAL_ENGINEERS_READ: "electrical-engineers:read",
  ELECTRICAL_ENGINEERS_CREATE: "electrical-engineers:create",
  ELECTRICAL_ENGINEERS_UPDATE: "electrical-engineers:update",
  ELECTRICAL_ENGINEERS_DELETE: "electrical-engineers:delete",

  // Reordering the phases is part of :update.
  ELEC_PHASES_READ: "elec-phases:read",
  ELEC_PHASES_CREATE: "elec-phases:create",
  ELEC_PHASES_UPDATE: "elec-phases:update",
  ELEC_PHASES_DELETE: "elec-phases:delete",

  AREAS_READ: "areas:read",
  AREAS_CREATE: "areas:create",
  AREAS_UPDATE: "areas:update",
  AREAS_DELETE: "areas:delete",

  CONTRACTORS_READ: "contractors:read",
  CONTRACTORS_CREATE: "contractors:create",
  CONTRACTORS_UPDATE: "contractors:update",
  CONTRACTORS_DELETE: "contractors:delete",
  CONTRACTORS_SUMMARY: "contractors:summary",
  // Also opens the import template.
  CONTRACTORS_IMPORT: "contractors:import",

  // The maintenance villas: the list (open and solved) and one item are both :read. Checking one as solved is :update.
  MAINTENANCE_READ: "maintenance:read",
  MAINTENANCE_CREATE: "maintenance:create",
  MAINTENANCE_UPDATE: "maintenance:update",
  MAINTENANCE_DELETE: "maintenance:delete",

  // Material deliveries from the switchgear and cable factories. :update also manages the factories list and the
  // delivery notes; :read also opens a delivery note and a villa's materials summary.
  MATERIALS_READ: "materials:read",
  MATERIALS_CREATE: "materials:create",
  MATERIALS_UPDATE: "materials:update",
  MATERIALS_DELETE: "materials:delete",

  VILLA_DOCUMENTS_UPLOAD: "villa-documents:upload",
  VILLA_DOCUMENTS_DOWNLOAD: "villa-documents:download",
  VILLA_DOCUMENTS_DELETE: "villa-documents:delete",

  USERS_READ: "users:read",
  USERS_CREATE: "users:create",
  USERS_UPDATE: "users:update",
  USERS_DEACTIVATE: "users:deactivate",
  // Deleting a user for good (not an ADMIN, not yourself, not one who created villas or uploaded documents).
  USERS_DELETE: "users:delete",

  PERMISSIONS_ASSIGN: "permissions:assign",
  AUDIT_READ: "audit:read",
  DASHBOARD_READ: "dashboard:read",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_CODES: readonly Permission[] = Object.values(PERMISSIONS);
