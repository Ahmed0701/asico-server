import type { FactoryTypeValue } from "../../../shared/constants/enums.js";
import type { PageMeta } from "../../../shared/query/pagination.js";

export type AssignedFactoryDto = { id: string; name: string };

// A villa and the factories assigned to supply it (the Vendors page): its switchgear factory and its cable factory, null
// while not assigned. `version` is the villa's, for If-Match on the next assignment.
export type VillaVendorsDto = {
  villa: { id: string; villaNumber: string; location: string };
  switchgear: AssignedFactoryDto | null;
  cable: AssignedFactoryDto | null;
  version: number;
  // When the villa was added to the Vendors list; null while it is not on it.
  listedAt: string | null;
};

export type AvailableVillaDto = { id: string; villaNumber: string };

// Over every villa the filters match (not only this page).
export type VillaVendorsSummaryDto = {
  villaCount: number;
  // Of them, the villas with a switchgear factory assigned, and with a cable factory.
  withSwitchgear: number;
  withCable: number;
  // Every villa of the project (on the list or not, whatever the filters) with no factory assigned at all.
  withNone: number;
};

export type VillaVendorsListResult = {
  items: VillaVendorsDto[];
  meta: PageMeta;
  summary: VillaVendorsSummaryDto;
};

// `missing`: the villas with no factory of that type assigned yet.
export type VendorFilters = {
  search?: string | undefined;
  factoryId?: string | undefined;
  missing?: FactoryTypeValue | undefined;
};
