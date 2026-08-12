import * as Sentry from "@sentry/nextjs";

type CronJob = () => Promise<Response>;

type SentryCronOptions = {
  slug: string;
  aliases?: string[];
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
  const monitorSlugs = [options.slug, ...(options.aliases ?? [])];
  const checkIns = new Map<string, string>();
  for (const monitorSlug of monitorSlugs) {
    observe(() => {
      checkIns.set(
        monitorSlug,
        Sentry.captureCheckIn(
          { monitorSlug, status: "in_progress" },
          {
            schedule: { type: "crontab", value: options.schedule },
            checkinMargin: 1,
            maxRuntime: options.maxRuntimeMinutes ?? 2,
            failureIssueThreshold: 2,
            recoveryThreshold: 1,
            timezone: "UTC",
          },
        ),
      );
    });
  }
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await job();
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    for (const [monitorSlug, checkInId] of checkIns) {
      observe(() => {
        Sentry.captureCheckIn({
          checkInId,
          monitorSlug,
          status: "error",
          duration: durationMs / 1_000,
        });
      });
    }
    observe(() => {
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
  for (const [monitorSlug, checkInId] of checkIns) {
    observe(() => {
      Sentry.captureCheckIn({
        checkInId,
        monitorSlug,
        status,
        duration: durationMs / 1_000,
      });
    });
  }
  observe(() => {
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
