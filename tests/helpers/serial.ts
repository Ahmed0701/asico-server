// Runs jobs one after another, in the order they were asked for. The in-memory fakes use it so that two transactions
// never overlap, as with a row lock in the database: the second waits until the first has finished, then reads what the
// first wrote. (A rollback that restores a snapshot would otherwise throw away a neighbour's committed change.)
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
