export const LOCALES = ["en", "ar"] as const;

export type LocaleCode = (typeof LOCALES)[number];

// Whether a civil engineer, an electrical engineer or a contractor is still working with us.
export const PARTY_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type PartyStatusValue = (typeof PARTY_STATUSES)[number];

// How a villa is built.
export const VILLA_TYPES = ["ACICO_SYSTEM", "CONVENTIONAL"] as const;
export type VillaTypeValue = (typeof VILLA_TYPES)[number];

// Where a villa's file stands with MEW, for the AC and for the electricity.
export const MEW_STATES = ["NOT_SUBMITTED", "RUNNING", "APPROVED"] as const;
export type MewStateValue = (typeof MEW_STATES)[number];

// Where delivered material comes from (switchgear or cable factories).
export const FACTORY_TYPES = ["SWITCHGEAR", "CABLE"] as const;
export type FactoryTypeValue = (typeof FACTORY_TYPES)[number];
