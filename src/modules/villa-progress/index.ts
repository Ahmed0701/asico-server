export { villaProgressRouter } from "./routes/villa-progress.routes.js";

export {
  MAX_PROGRESS,
  PROGRESS_STATES,
  averageProgress,
  stateOf,
  type PhaseProgressDto,
  type PhaseProgressUpdateDto,
  type ProgressState,
} from "./dto/villa-progress.dto.js";
export {
  progressChangeHooks,
  type ProgressChange,
  type ProgressChangeHook,
} from "./service/villa-progress.service.js";

// What the villas and the elec phases use to keep the one-row-per-villa-and-phase rule.
export {
  countRowsInProgress,
  deleteRowsAtZero,
  insertRowsForPhase,
  insertRowsForVilla,
  lockPhaseSet,
} from "./repository/progress-rows.js";
