// Every piece of text a generated file shows. Exports are always in English, whatever language the request
// asked for, so none of this goes through the translation files.

export const REPORT = {
  brand: "Asico",
  generated: "Generated",
  filters: "Filters",
  noFilters: "None (all records)",
  noRecords: "No records",
  utc: "UTC",
  yes: "Yes",
  no: "No",
  system: "System",
  page: (current: number, total: number): string => `Page ${current} of ${total}`,
} as const;

export const PARTY_STATUS_LABELS = {
  ACTIVE: "Active",
  INACTIVE: "Inactive",
} as const;

// The words an open work's enums are shown with, in exports and in the import template.
export const WORK_STATUS_LABELS = {
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  DELAYED: "Delayed",
  DONE: "Done",
} as const;

export const PRIORITY_LABELS = {
  LOW: "Low",
  MEDIUM: "Medium",
  HIGH: "High",
} as const;

// The weather of a daily report, in exports and in the import template.
export const WEATHER_LABELS = {
  HOT: "Hot",
  SUNNY: "Sunny",
  WINDY: "Windy",
  RAINY: "Rainy",
  DUSTY: "Dusty",
} as const;

// The status of a daily small work, in exports and in the import template.
export const SMALL_WORK_STATUS_LABELS = {
  PENDING: "Pending",
  DONE: "Done",
} as const;

// The type of a site report, in exports and in the import template.
export const SITE_REPORT_TYPE_LABELS = {
  INSPECTION: "Inspection",
  SAFETY: "Safety",
  PROGRESS: "Progress",
  QUALITY: "Quality",
} as const;

export const SUMMARY_LABELS = {
  contractor: "Contractor",
  phone: "Phone",
  total: "Total villas",
} as const;

export const FILTER_LABELS: Record<string, string> = {
  status: "Status",
  area: "Area",
  areaId: "Area ID",
  block: "Block",
  plot: "Plot",
  civilEngineerId: "Civil engineer ID",
  electricalEngineerId: "Electrical engineer ID",
  contractorId: "Contractor ID",
  preparedByEngineerId: "Prepared by (engineer ID)",
  villaId: "Villa ID",
  elecPhaseId: "Electrical phase ID",
  priority: "Priority",
  overdue: "Overdue",
  done: "Done",
  dueSoon: "Due soon",
  reportFrom: "Report from",
  reportTo: "Report to",
  weather: "Weather",
  visitFrom: "Visit from",
  visitTo: "Visit to",
  labourFrom: "Labour from",
  labourTo: "Labour to",
  type: "Type",
  rating: "Rating",
  startFrom: "Start from",
  startTo: "Start to",
  endFrom: "End from",
  endTo: "End to",
  targetFrom: "Target from",
  targetTo: "Target to",
  mewFollowUp: "MEW follow up",
  mewInspection: "MEW inspection",
  mewInspectionPassed: "MEW inspection passed",
  villaType: "Villa type",
  search: "Search",
  sort: "Sort",
  actorId: "Actor ID",
  action: "Action",
  entity: "Entity",
  entityId: "Entity ID",
  from: "From",
  to: "To",
};

// What each export is called: the title in a PDF, the sheet name in a workbook, and the file name stem.
export const EXPORT_NAMES = {
  villas: { title: "Villas", sheet: "Villas", file: "villas" },
  contractors: { title: "Contractors", sheet: "Contractors", file: "contractors" },
  civilEngineers: { title: "Civil Engineers", sheet: "Civil Engineers", file: "civil-engineers" },
  electricalEngineers: {
    title: "Electrical Engineers",
    sheet: "Electrical Engineers",
    file: "electrical-engineers",
  },
  areas: { title: "Areas", sheet: "Areas", file: "areas" },
  contractorSummary: {
    title: "Contractor Summary",
    sheet: "Contractor Summary",
    file: "contractor-summary",
  },
  auditLogs: { title: "Audit Log", sheet: "Audit Log", file: "audit-logs" },
  openWorks: { title: "Open Works", sheet: "Open Works", file: "open-works" },
  dailyReports: { title: "Daily Reports", sheet: "Daily Reports", file: "daily-reports" },
  smallWorks: { title: "Daily Small Works", sheet: "Daily Small Works", file: "small-works" },
  siteReports: { title: "Site Reports", sheet: "Site Reports", file: "site-reports" },
  dailyLabour: { title: "Daily Labour", sheet: "Daily Labour", file: "daily-labour" },
} as const;

export const COLUMN_TITLES = {
  villaNumber: "Villa Number",
  ownerName: "Owner Name",
  area: "Area",
  block: "Block",
  plot: "Plot",
  status: "Status",
  civilEngineer: "Civil Engineer",
  electricalEngineer: "Electrical Engineer",
  contractor: "Contractor",
  startDate: "Start Date",
  targetDate: "Target Date",
  budget: "Budget",
  currency: "Currency",
  progress: "Progress",
  createdAt: "Created (UTC)",
  name: "Name",
  phone: "Phone",
  email: "Email",
  city: "City",
  villaCount: "Villas",
  time: "Time (UTC)",
  actorName: "Actor",
  actorEmail: "Actor Email",
  action: "Action",
  entity: "Entity",
  entityId: "Entity ID",
  ip: "IP",
  userAgent: "User Agent",
  requestId: "Request ID",
  location: "Location",
  title: "Title",
  elecPhase: "Electrical Phase",
  priority: "Priority",
  endDate: "End Date",
  overdue: "Overdue",
  reportDate: "Report Date",
  weather: "Weather",
  workersCount: "Workers",
  description: "Description",
  visitDate: "Visit Date",
  inspector: "Inspector",
  type: "Type",
  rating: "Rating",
  findings: "Findings",
  recommendations: "Recommendations",
  labourDate: "Labour Date",
  labourCount: "Labour Count",
  notes: "Notes",
} as const;
