import type { MaintenanceRow } from "../../../src/modules/maintenance/repository/maintenance.repository.js";

// The maintenance villas of the fakes, shared by the maintenance repository and the dashboard's.
export const maintenanceTables = {
  rows: [] as MaintenanceRow[],
  reset(): void {
    this.rows = [];
  },
};
