import { MonthlyProgressRepository } from "../repository/monthly-progress.repository.js";
import { withoutVillaScope } from "../../../core/scope/villa-scope.js";
import { eventsByWork, villaProgressFromWorks, worksAt } from "./progress-history.js";

// How long a past instant's figures are kept. They hardly change: the audit log is append-only and every event after
// the instant is later than it, so only a change of the phases (switched off, another ratio) or a deleted villa moves
// them, and that shows within this time.
export const PAST_PROGRESS_TTL_MS = 5 * 60_000;

type Entry = { expires: number; value: Promise<Map<string, number>> };

// Shared by every request of this process, keyed by the instant (ISO). A month boundary is one key, so it stays small.
const cache = new Map<string, Entry>();

/** Empties the cache (tests that change the history between two reads). */
export function clearProgressHistoryCache(): void {
  cache.clear();
}

/**
 * Every villa's overall progress, now and at past instants.
 *
 *  - Now comes straight from the open works as they are, in one grouped query (no history needed).
 *  - A past instant is rebuilt from the open works' history (see progress-history.ts), which reads the whole history and
 *    works it out in this process: on a large dataset that takes a second and holds the event loop meanwhile. So each
 *    instant is worked out once, cached for PAST_PROGRESS_TTL_MS, and requests that arrive while it is being worked out
 *    share the same promise instead of starting their own. Several instants asked together share one read of the data.
 */
export class ProgressHistory {
  constructor(
    private readonly repository = new MonthlyProgressRepository(),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  async current(): Promise<Map<string, number>> {
    const [phases, averages] = await Promise.all([
      this.repository.activePhases(),
      this.repository.currentPhaseAverages(),
    ]);
    return villaProgressFromWorks(averages, phases);
  }

  async at(instants: readonly Date[]): Promise<Map<string, number>[]> {
    const now = this.clock();
    for (const [key, entry] of cache) {
      if (entry.expires <= now) cache.delete(key);
    }
    const missing = instants.filter((instant) => !cache.has(instant.toISOString()));
    if (missing.length > 0) {
      // The cache is shared by every request: it is read for every villa, whoever asked first.
      const data = withoutVillaScope(() => this.load());
      for (const instant of missing) {
        const key = instant.toISOString();
        const value = data.then((d) => villaProgressFromWorks(worksAt(instant, d.works, d.byWork), d.phases));
        cache.set(key, { expires: now + PAST_PROGRESS_TTL_MS, value });
        // A failed read is not kept: the next request tries again.
        value.catch(() => cache.delete(key));
      }
    }
    return Promise.all(instants.map((instant) => cache.get(instant.toISOString())!.value));
  }

  private async load() {
    const [phases, works, events] = await Promise.all([
      this.repository.activePhases(),
      this.repository.works(),
      this.repository.workEvents(),
    ]);
    return { phases, works, byWork: eventsByWork(events) };
  }
}
