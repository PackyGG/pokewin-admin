import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const DEFAULT_TIMEOUT_MS = 12_000;

function normalizedBaseUrl(value, name) {
  if (!value?.trim()) throw new Error(`${name} is not configured`);
  const url = new URL(value.trim());
  if (url.protocol !== "https:") {
    throw new Error(`${name} must use https`);
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function safeTarget(url) {
  return `${url.origin}${url.pathname}`;
}

async function probe({ name, url, headers = {}, validate, fetchImpl, timeoutMs }) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(url, {
      headers,
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // A platform error page is intentionally reported as a status/shape
      // failure without copying its HTML into issues or Discord.
    }
    const validationError = response.ok
      ? validate?.(payload, response) ?? null
      : `HTTP ${response.status}`;
    return {
      name,
      ok: response.ok && validationError === null,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      target: safeTarget(url),
      error: validationError,
    };
  } catch (error) {
    return {
      name,
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      target: safeTarget(url),
      error:
        error instanceof Error && error.name === "TimeoutError"
          ? `timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : "request failed",
    };
  }
}

export async function runProductionHealthChecks({
  baseUrl,
  railwayHealthUrl,
  healthToken,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const app = normalizedBaseUrl(baseUrl, "PRODUCTION_BASE_URL");
  const railway = normalizedBaseUrl(
    railwayHealthUrl,
    "RAILWAY_HEALTH_URL",
  );
  if (!healthToken?.trim()) {
    throw new Error("CRON_SECRET is not configured");
  }

  const checks = await Promise.all([
    probe({
      name: "Vercel application",
      url: new URL("/login", app),
      fetchImpl,
      timeoutMs,
    }),
    probe({
      name: "Vercel runtime",
      url: new URL("/api/health/antifraud-webapp", app),
      fetchImpl,
      timeoutMs,
      validate: (payload) =>
        payload?.status === "healthy" ? null : "unexpected health payload",
    }),
    probe({
      name: "PostgreSQL mirror",
      url: new URL("/api/health/postgres", app),
      headers: { Authorization: `Bearer ${healthToken.trim()}` },
      fetchImpl,
      timeoutMs,
      validate: (payload) =>
        payload?.ok === true &&
        payload?.reachable === true &&
        payload?.replicationHealthy === true
          ? null
          : "database or replication unhealthy",
    }),
    probe({
      name: "Railway backend",
      url: new URL("/health", railway),
      fetchImpl,
      timeoutMs,
      validate: (payload) =>
        payload?.status === "ok" || payload?.status === "healthy"
          ? null
          : "unexpected health payload",
    }),
  ]);

  return {
    ok: checks.every((check) => check.ok),
    checkedAt: new Date().toISOString(),
    checks,
  };
}

export function formatHealthReport(report) {
  const lines = report.checks.map((check) => {
    const state = check.ok ? "OK" : "FAIL";
    const status = check.status === null ? "no response" : `HTTP ${check.status}`;
    const error = check.error ? ` — ${check.error}` : "";
    return `- ${state} ${check.name}: ${status}, ${check.latencyMs}ms (${check.target})${error}`;
  });
  return [`Production health: ${report.ok ? "healthy" : "unhealthy"}`, ...lines].join("\n");
}

async function main() {
  let report;
  try {
    report = await runProductionHealthChecks({
      baseUrl: process.env.PRODUCTION_BASE_URL,
      railwayHealthUrl: process.env.RAILWAY_HEALTH_URL,
      healthToken: process.env.CRON_SECRET,
      timeoutMs: Number(process.env.PRODUCTION_HEALTH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    });
  } catch (error) {
    report = {
      ok: false,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          name: "Monitor configuration",
          ok: false,
          status: null,
          latencyMs: 0,
          target: "configuration",
          error: error instanceof Error ? error.message : "invalid configuration",
        },
      ],
    };
  }

  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.PRODUCTION_HEALTH_REPORT_PATH) {
    await writeFile(process.env.PRODUCTION_HEALTH_REPORT_PATH, output, {
      mode: 0o600,
    });
  }
  console.log(formatHealthReport(report));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    console.error(
      `Production health monitor failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exitCode = 1;
  });
}
