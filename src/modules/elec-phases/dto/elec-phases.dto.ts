import type { PageMeta } from "../../../shared/query/pagination.js";

export const ELEC_PHASE_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type ElecPhaseStatusValue = (typeof ELEC_PHASE_STATUSES)[number];

// The options list feeds select inputs. It is cut at this many entries so the response stays bounded. The same number
// caps a reorder request, which must name every phase.
export const MAX_OPTIONS = 1000;

// The progress ratio of a phase: how much it counts in a villa's overall progress.
export const MAX_PROGRESS_RATIO = 100;

export type ElecPhaseDto = {
  id: string;
  name: string;
  sortOrder: number;
  status: ElecPhaseStatusValue;
  // 0 to 100: what the phase adds to a villa's overall progress once the villa's open work for it is done.
  progressRatio: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ElecPhaseOptionDto = { id: string; name: string };

export type ElecPhaseListResult = { items: ElecPhaseDto[]; meta: PageMeta };
