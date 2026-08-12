type AsyncTask<T> = () => Promise<T>;

type TaskResults<Tasks extends readonly AsyncTask<unknown>[]> = {
  [Key in keyof Tasks]: Awaited<ReturnType<Tasks[Key]>>;
};

/**
 * Run heterogeneous async work without letting one request exhaust a small
 * database pool. Results preserve task order, matching Promise.all.
 */
export async function runWithConcurrency<
  const Tasks extends readonly AsyncTask<unknown>[],
>(tasks: Tasks, concurrency: number): Promise<TaskResults<Tasks>> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: unknown[] = new Array(tasks.length);
  let nextIndex = 0;
  // `Promise.all` rejects on the first failure, but the sibling workers used to
  // keep pulling tasks afterwards. Those queries then ran to completion — or to
  // the 30s statement_timeout — holding scarce pool slots for a result the
  // caller had already thrown away, which is exactly when the pool is most
  // contended. Stop handing out work once the batch is doomed.
  let failed = false;

  async function worker() {
    while (!failed && nextIndex < tasks.length) {
      const index = nextIndex++;
      try {
        results[index] = await tasks[index]();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
  return results as TaskResults<Tasks>;
}
