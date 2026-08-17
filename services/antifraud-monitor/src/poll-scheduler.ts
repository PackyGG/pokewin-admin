/**
 * Preserve a configured start-to-start poll cadence without ever overlapping
 * work. Slow ticks restart immediately; fast ticks wait only for the remainder
 * of the interval.
 */
export function nextPollDelayMs(intervalMs: number, elapsedMs: number): number {
  return Math.max(0, intervalMs - Math.max(0, elapsedMs));
}
