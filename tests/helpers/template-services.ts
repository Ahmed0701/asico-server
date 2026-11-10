import { ContractorsImportService } from "../../src/modules/contractors/service/contractors-import.service.js";
import { DailyLabourImportService } from "../../src/modules/daily-labour/service/daily-labour-import.service.js";
import type { DailyLabourRepository } from "../../src/modules/daily-labour/repository/daily-labour.repository.js";
import { DailyReportsImportService } from "../../src/modules/daily-reports/service/daily-reports-import.service.js";
import type { DailyReportsRepository } from "../../src/modules/daily-reports/repository/daily-reports.repository.js";
import { OpenWorksImportService } from "../../src/modules/open-works/service/open-works-import.service.js";
import type { OpenWorksRepository } from "../../src/modules/open-works/repository/open-works.repository.js";
import { SiteReportsImportService } from "../../src/modules/site-reports/service/site-reports-import.service.js";
import type { SiteReportsRepository } from "../../src/modules/site-reports/repository/site-reports.repository.js";
import { SmallWorksImportService } from "../../src/modules/small-works/service/small-works-import.service.js";
import type { SmallWorksRepository } from "../../src/modules/small-works/repository/small-works.repository.js";
import { VillasImportService } from "../../src/modules/villas/service/villas-import.service.js";
import type { VillasRepository } from "../../src/modules/villas/repository/villas.repository.js";

type TemplateFile = { fileName: string; bytes: Buffer };

// The reads a template makes (the records its dropdowns point to), answering with none: a template can then be built without a
// database, and its dropdowns are the fixed ones only.
const none = {
  importVillas: async () => [],
  importContractors: async () => [],
  importAreas: async () => [],
  importCivilEngineers: async () => [],
  importElectricalEngineers: async () => [],
  importEngineers: async () => [],
  importElecPhases: async () => [],
};
const empty = <T>(): T => none as unknown as T;

// The seven import templates over no records, by resource.
export const emptyTemplates: Record<string, () => Promise<TemplateFile>> = {
  contractors: () => new ContractorsImportService().template(),
  "daily-labour": () => new DailyLabourImportService(empty<DailyLabourRepository>()).template(),
  "daily-reports": () => new DailyReportsImportService(empty<DailyReportsRepository>()).template(),
  "open-works": () => new OpenWorksImportService(empty<OpenWorksRepository>()).template(),
  "site-reports": () => new SiteReportsImportService(empty<SiteReportsRepository>()).template(),
  "small-works": () => new SmallWorksImportService(empty<SmallWorksRepository>()).template(),
  villas: () => new VillasImportService(empty<VillasRepository>()).template(),
};
