import type { ForemanMissionRow } from "../../../src/modules/foreman-missions/repository/foreman-missions.repository.js";

// The foreman missions of the fakes, shared by the foreman missions repository and the dashboard's. A row keeps the villa's id; the
// villa's number, owner and location are read from the villa fakes when a row is returned.
export type StoredForemanMission = Omit<ForemanMissionRow, "villa"> & { villaId: string };

export const foremanMissionTables = {
  rows: [] as StoredForemanMission[],
  reset(): void {
    this.rows = [];
  },
};
