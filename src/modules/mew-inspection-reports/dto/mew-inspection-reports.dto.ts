// The MEW inspection report of a villa (a PDF): its name and size, who uploaded it and when.
export type MewReportDto = {
  villaId: string;
  name: string;
  size: number;
  uploadedBy: { id: string; name: string } | null;
  uploadedAt: string;
};

// The reports one request asks for at most (the villas of one page of the MEW Inspection list).
export const MAX_REPORT_VILLAS = 200;
