export { civilEngineersRouter } from "./routes/civil-engineers.routes.js";

// What the exports module reuses: the list query, exactly as the endpoint runs it.
export { CivilEngineersService } from "./service/civil-engineers.service.js";
export {
  listCivilEngineersQuerySchema,
  type ListCivilEngineersQuery,
} from "./validators/civil-engineers.validators.js";
export type { CivilEngineerDto } from "./dto/civil-engineers.dto.js";
