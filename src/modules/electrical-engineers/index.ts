export { electricalEngineersRouter } from "./routes/electrical-engineers.routes.js";

// What the exports module reuses: the list query, exactly as the endpoint runs it.
export { ElectricalEngineersService } from "./service/electrical-engineers.service.js";
export {
  listElectricalEngineersQuerySchema,
  type ListElectricalEngineersQuery,
} from "./validators/electrical-engineers.validators.js";
export type { ElectricalEngineerDto } from "./dto/electrical-engineers.dto.js";
