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

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
  );
  return results as TaskResults<Tasks>;
}
