export { contractorsRouter } from "./routes/contractors.routes.js";

// What the exports module reuses: the list and summary queries, exactly as the endpoints run them.
export { ContractorsService } from "./service/contractors.service.js";
export {
  contractorSummaryQuerySchema,
  listContractorsQuerySchema,
  type ContractorSummaryQuery,
  type ListContractorsQuery,
} from "./validators/contractors.validators.js";
export type { ContractorDto, ContractorSummaryResult } from "./dto/contractors.dto.js";
export {
  CONTRACTOR_IGNORED_COLUMNS,
  CONTRACTOR_IMPORT_COLUMNS,
} from "./service/contractors-import.service.js";
