import * as Sentry from "@sentry/nextjs";

type CronJob = () => Promise<Response>;

type SentryCronOptions = {
  slug: string;
  schedule: string;
  maxRuntimeMinutes?: number;
};

function observe(report: () => void): void {
  try {
    report();
  } catch {
    // A monitoring outage must never prevent or replace the cron job result.
  }
}

/**
 * Report one authenticated cron execution to Sentry.
 *
 * Explicit instrumentation is intentional: it works independently of the
 * experimental Vercel/App Router span hook and treats non-2xx responses as
 * failed check-ins even when the route handler returns normally.
 */
export async function runSentryCronMonitor(
  options: SentryCronOptions,
  job: CronJob,
): Promise<Response> {
  let checkInId: string | undefined;
  observe(() => {
    checkInId = Sentry.captureCheckIn(
      { monitorSlug: options.slug, status: "in_progress" },
      {
        schedule: { type: "crontab", value: options.schedule },
        checkinMargin: 1,
        maxRuntime: options.maxRuntimeMinutes ?? 2,
        failureIssueThreshold: 2,
        recoveryThreshold: 1,
        timezone: "UTC",
      },
    );
  });
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await job();
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    observe(() => {
      if (checkInId) {
        Sentry.captureCheckIn({
          checkInId,
          monitorSlug: options.slug,
          status: "error",
          duration: durationMs / 1_000,
        });
      }
      Sentry.metrics.count("cron.runs", 1, {
        attributes: { cron: options.slug, status: "error" },
      });
      Sentry.metrics.distribution("cron.duration", durationMs, {
        unit: "millisecond",
        attributes: { cron: options.slug, status: "error" },
      });
      Sentry.logger.error("Cron job threw", { cron: options.slug });
    });
    throw error;
  }

  const durationMs = Date.now() - startedAt;
  const status = response.ok ? "ok" : "error";
  observe(() => {
    if (checkInId) {
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug: options.slug,
        status,
        duration: durationMs / 1_000,
      });
    }
    Sentry.metrics.count("cron.runs", 1, {
      attributes: { cron: options.slug, status },
    });
    Sentry.metrics.distribution("cron.duration", durationMs, {
      unit: "millisecond",
      attributes: { cron: options.slug, status },
    });
    if (!response.ok) {
      Sentry.logger.error("Cron job returned an unsuccessful response", {
        cron: options.slug,
        status_code: response.status,
      });
    }
  });
  return response;
}
