export type PollerHealthSnapshot = {
  status: "starting" | "healthy" | "degraded" | "standby";
  running: boolean;
  leader: boolean;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  lastSuccessfulTickAt: string | null;
  lastTickDurationMs: number | null;
  consecutiveFailures: number;
  skippedTicks: number;
  signupsProcessed: number;
  activitiesProcessed: number;
  signupBacklogPossible: boolean;
  signupCursorLagMs: number | null;
  lastError: string | null;
};

export function pollerStalledFor(
  poller: PollerHealthSnapshot,
  timeoutMs: number,
  now = Date.now(),
): number | null {
  if (!poller.leader) return null;
  const last = poller.lastSuccessfulTickAt ?? poller.lastTickCompletedAt;
  if (!last) return null;
  const parsed = Date.parse(last);
  if (Number.isNaN(parsed)) return null;
  const age = Math.max(0, now - parsed);
  return age > timeoutMs ? age : null;
}

export class PollerHealth {
  private running = false;
  private leader = false;
  private lastTickStartedAt: Date | null = null;
  private lastTickCompletedAt: Date | null = null;
  private lastSuccessfulTickAt: Date | null = null;
  private lastTickDurationMs: number | null = null;
  private consecutiveFailures = 0;
  private skippedTicks = 0;
  private signupsProcessed = 0;
  private activitiesProcessed = 0;
  private signupBacklogPossible = false;
  private signupCursorLagMs: number | null = null;
  private lastError: string | null = null;

  tickStarted(now = new Date()): void {
    this.running = true;
    this.lastTickStartedAt = now;
  }

  tickSkipped(): void {
    this.skippedTicks += 1;
  }

  standby(now = new Date()): void {
    this.leader = false;
    this.running = false;
    this.lastTickCompletedAt = now;
  }

  tickSucceeded(
    metrics: {
      signupsProcessed: number;
      activitiesProcessed: number;
      signupBacklogPossible: boolean;
      signupCursorLagMs: number | null;
    },
    now = new Date(),
  ): void {
    this.leader = true;
    this.running = false;
    this.lastTickCompletedAt = now;
    this.lastSuccessfulTickAt = now;
    this.lastTickDurationMs = this.duration(now);
    this.consecutiveFailures = 0;
    this.signupsProcessed = metrics.signupsProcessed;
    this.activitiesProcessed = metrics.activitiesProcessed;
    this.signupBacklogPossible = metrics.signupBacklogPossible;
    this.signupCursorLagMs = metrics.signupCursorLagMs;
    this.lastError = null;
  }

  tickFailed(message: string, now = new Date()): void {
    this.leader = true;
    this.running = false;
    this.lastTickCompletedAt = now;
    this.lastTickDurationMs = this.duration(now);
    this.consecutiveFailures += 1;
    this.lastError = message.slice(0, 300);
  }

  snapshot(staleAfterMs: number, now = new Date()): PollerHealthSnapshot {
    let status: PollerHealthSnapshot["status"] = "starting";
    if (!this.leader && this.lastTickCompletedAt) {
      status = "standby";
    } else if (this.lastSuccessfulTickAt) {
      const stale = now.getTime() - this.lastSuccessfulTickAt.getTime() > staleAfterMs;
      status =
        stale || this.consecutiveFailures > 0 || this.signupBacklogPossible
          ? "degraded"
          : "healthy";
    } else if (this.consecutiveFailures > 0) {
      status = "degraded";
    }

    return {
      status,
      running: this.running,
      leader: this.leader,
      lastTickStartedAt: this.lastTickStartedAt?.toISOString() ?? null,
      lastTickCompletedAt: this.lastTickCompletedAt?.toISOString() ?? null,
      lastSuccessfulTickAt: this.lastSuccessfulTickAt?.toISOString() ?? null,
      lastTickDurationMs: this.lastTickDurationMs,
      consecutiveFailures: this.consecutiveFailures,
      skippedTicks: this.skippedTicks,
      signupsProcessed: this.signupsProcessed,
      activitiesProcessed: this.activitiesProcessed,
      signupBacklogPossible: this.signupBacklogPossible,
      signupCursorLagMs: this.signupCursorLagMs,
      lastError: this.lastError,
    };
  }

  private duration(now: Date): number | null {
    return this.lastTickStartedAt
      ? Math.max(0, now.getTime() - this.lastTickStartedAt.getTime())
      : null;
  }
}
