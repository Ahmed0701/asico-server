import type { MewStateValue, VillaTypeValue } from "../../../shared/constants/enums.js";
import type { PageMeta } from "../../../shared/query/pagination.js";
import type { PhaseProgressDto } from "../../villa-progress/dto/villa-progress.dto.js";

// "location" is the area's name, then the block, then the plot, each in natural order ("2" before "10"). "progress"
// is the overall progress, unrounded, so villas that show the same rounded figure still keep their true order.
export const VILLA_SORT_FIELDS = ["location", "targetDate", "villaNumber", "progress", "createdAt"] as const;
export type VillaSortField = (typeof VILLA_SORT_FIELDS)[number];

export function isVillaSortField(value: string): value is VillaSortField {
  return (VILLA_SORT_FIELDS as readonly string[]).includes(value);
}

export type VillaSort = { field: VillaSortField; direction: "asc" | "desc" };

// Bounds that keep responses small however large the data grows.
export const MAX_OPTIONS = 1000;
export const MAX_FILTER_VALUES = 1000;

// The currency a budget gets when it is sent without one.
export const DEFAULT_CURRENCY = "KWD";
// The biggest budget (2^53 - 1 minor units): the API carries it as a JSON number.
export const MAX_BUDGET_MINOR = Number.MAX_SAFE_INTEGER;

export type VillaFilters = {
  // The area's name (ignoring case) or its id.
  area?: string | undefined;
  areaId?: string | undefined;
  block?: string | undefined;
  plot?: string | undefined;
  civilEngineerId?: string | undefined;
  electricalEngineerId?: string | undefined;
  contractorId?: string | undefined;
  startFrom?: Date | undefined;
  startTo?: Date | undefined;
  targetFrom?: Date | undefined;
  targetTo?: Date | undefined;
  // Looks in exactly four places: the villa number, the civil engineer's name, the electrical engineer's name and the
  // owner's name.
  search?: string | undefined;
  // true: only villas on the MEW follow-up list; false: only those that are not.
  mewFollowUp?: boolean | undefined;
  // true: only villas on the MEW inspection list; false: only those that are not.
  mewInspection?: boolean | undefined;
  // true: only villas that passed the MEW inspection; false: only those that have not.
  mewInspectionPassed?: boolean | undefined;
  // Only villas of this type (villas with no type set are left out).
  villaType?: VillaTypeValue | undefined;
};

type Party = { id: string; name: string };

// When a mark was put on a villa (MEW follow-up, MEW inspection, passed) and by whom. `by` is null when that user has
// been deleted since.
export type VillaMarkDto = { at: string; by: Party | null };

export type VillaListItemDto = {
  id: string;
  villaNumber: string;
  ownerName: string | null;
  // How the villa is built; null when it has not been set.
  villaType: VillaTypeValue | null;
  // The area's name, with its id beside it.
  area: string;
  areaId: string;
  block: string;
  plot: string;
  // "<area> . <block> . <plot>", as the list shows and sorts it.
  location: string;
  civilEngineer: Party;
  electricalEngineer: Party | null;
  // The one contractor building the villa; null while none is set.
  contractor: Party | null;
  // Calendar days, YYYY-MM-DD.
  startDate: string | null;
  targetDate: string | null;
  // The budget in minor units (an integer) with its ISO 4217 currency; both null when there is no budget.
  budgetMinor: number | null;
  currency: string | null;
  // Overall progress, 0 to 100: the progress ratios of the active phases whose open work on the villa is done (100) added up, never more than 100 (0 when none is done).
  // Derived on read, never stored.
  progress: number;
  // Set only by a person (POST /villas/:id/mew-follow-up). null: not on the MEW follow-up list.
  mewFollowUp: VillaMarkDto | null;
  // Set only by a person (POST /villas/:id/mew-inspection). null: not on the MEW inspection list.
  mewInspection: VillaMarkDto | null;
  // Set only by a person (POST /villas/:id/mew-inspection-passed). null: has not passed the MEW inspection.
  mewInspectionPassed: VillaMarkDto | null;
  // Where the villa's file stands with MEW: NOT_SUBMITTED, RUNNING or APPROVED (PATCH /villas/:id/mew-states).
  mewAcState: MewStateValue;
  mewElecState: MewStateValue;
  // The day MEW is to inspect the villa, YYYY-MM-DD; null until it is picked (PATCH /villas/:id/mew-states).
  mewInspectionDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type VillaDetailDto = Omit<VillaListItemDto, "civilEngineer" | "electricalEngineer" | "contractor"> & {
  civilEngineer: Party & { phone: string };
  electricalEngineer: (Party & { phone: string }) | null;
  contractor: (Party & { phone: string }) | null;
  createdBy: { id: string; name: string };
  // How many active phases the progress is averaged over.
  phaseCount: number;
  // The active phases, in display order, each with the villa's progress in it.
  phases: PhaseProgressDto[];
};

export type VillaOptionDto = { id: string; villaNumber: string };
// Values for the list's filter dropdowns. The engineers are those with at least one villa, active or not.
export type VillaFiltersDto = {
  areas: string[];
  blocks: string[];
  civilEngineers: Party[];
  electricalEngineers: Party[];
};
export type VillaListResult = { items: VillaListItemDto[]; meta: PageMeta };

// What the audit entry of a MEW follow-up or MEW inspection change records: the mark as it was and as it became, under
// its own names (mewFollowUpAt and mewFollowUpById, or mewInspectionAt and mewInspectionById).
export type MarkSnapshot = Record<string, string | null>;

// The fields recorded in an audit entry. Dates are YYYY-MM-DD.
export type VillaSnapshot = {
  villaNumber: string;
  ownerName: string | null;
  villaType: VillaTypeValue | null;
  areaId: string;
  block: string;
  plot: string;
  civilEngineerId: string;
  electricalEngineerId: string | null;
  contractorId: string | null;
  startDate: string | null;
  targetDate: string | null;
  budgetMinor: number | null;
  currency: string | null;
};
