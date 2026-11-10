export const MAX_PROGRESS = 100;

export const PROGRESS_STATES = ["NOT_STARTED", "IN_PROGRESS", "DONE"] as const;
export type ProgressState = (typeof PROGRESS_STATES)[number];

// 0 is not started, 100 is done, anything between is in progress.
export function stateOf(progress: number): ProgressState {
  if (progress <= 0) return "NOT_STARTED";
  return progress >= MAX_PROGRESS ? "DONE" : "IN_PROGRESS";
}

// The average of `count` progress values that add up to `sum`, to one decimal, halves rounding up. Whole-number maths, so
// 33.35 is never 33.349999. No phases give 0.
export function averageProgress(sum: number, count: number): number {
  if (count <= 0) return 0;
  return Math.floor((sum * 20 + count) / (2 * count)) / 10;
}

// A villa's progress in one phase, from the progress of its open works filed under that phase: their average, or 0 when
// there are none. Unrounded; the SQL twin is PHASE_PROGRESS.
export function phaseProgressOf(openWorkProgress: readonly number[]): number {
  if (openWorkProgress.length === 0) return 0;
  return openWorkProgress.reduce((sum, progress) => sum + progress, 0) / openWorkProgress.length;
}

// What one active phase adds to a villa's overall progress: its whole progress ratio once the villa's open work for it is
// done (100), and nothing before that. The SQL twin is PHASE_DONE_RATIO.
export function doneRatioOf(phase: { progress: number; progressRatio: number }): number {
  return phase.progress >= MAX_PROGRESS ? phase.progressRatio : 0;
}

// A villa's overall progress: what its done active phases add up to (doneRatioOf), never more than 100.
export function villaProgressOf(doneRatio: number): number {
  return Math.min(MAX_PROGRESS, doneRatio);
}

// One active phase of a villa, as the villa's detail lists it.
export type PhaseProgressDto = {
  elecPhaseId: string;
  name: string;
  // The phase's place in the list (its sortOrder).
  order: number;
  // In the villa's detail: read from the villa's open works filed under the phase, one decimal (0 with none).
  progress: number;
  state: ProgressState;
  // The version of the progress row: what the update's If-Match carries.
  version: number;
};

// What the progress update answers: the phase, and the villa's overall progress now.
export type PhaseProgressUpdateDto = PhaseProgressDto & {
  villaProgress: number;
  phaseCount: number;
};
