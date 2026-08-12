import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { repositoryFiles } from "./repository-files.ts";

const read = (path: string) => readFileSync(path, "utf8");

test("every App Router error boundary explicitly reports caught errors", () => {
  const boundaries = repositoryFiles({
    root: path.resolve(import.meta.dirname, "../.."),
    pathspecs: ["src/app/error.tsx", "src/app/**/error.tsx"],
  });
  assert.ok(
    boundaries.length >= 39,
    "expected the complete boundary inventory",
  );

  for (const path of boundaries) {
    const source = read(path);
    if (/export \{ default \} from/.test(source)) continue;
    assert.match(
      source,
      /reportWebappError\(/,
      `${path} must report its error`,
    );
  }
});

test("Sentry initializes all Next.js runtimes with privacy and tracing guards", () => {
  const client = read("src/instrumentation-client.ts");
  const server = read("src/sentry.server.config.ts");
  const edge = read("src/sentry.edge.config.ts");
  const instrumentation = read("src/instrumentation.ts");
  const nextConfig = read("next.config.ts");
  const middleware = read("src/middleware.ts");
  const sentryCron = read("src/lib/sentry-cron.ts");
  const cronRoutes = [
    read("src/app/api/cron/warm/route.ts"),
    read("src/app/api/cron/antifraud-containment-retry/route.ts"),
    read("src/app/api/cron/reward-abuse-detection/route.ts"),
  ].join("\n");

  assert.match(client, /Sentry\.init\(/);
  assert.doesNotMatch(client, /import\("@sentry\/nextjs"\)/);
  assert.match(client, /beforeSend: \(event\) => sanitizeSentryEvent\(event\)/);
  assert.match(client, /beforeSendTransaction:/);
  assert.match(client, /Sentry\.replayIntegration\(/);
  assert.match(client, /Sentry\.browserProfilingIntegration\(\)/);
  assert.match(client, /profileLifecycle: "trace"/);
  assert.match(client, /enableLogs: true/);
  assert.match(client, /maskAllText: true/);
  assert.match(client, /replaysOnErrorSampleRate: sentryReplayErrorSampleRate/);
  assert.match(client, /replaysSessionSampleRate: 0/);
  assert.match(
    client,
    /onRouterTransitionStart = Sentry\.captureRouterTransitionStart/,
  );
  assert.match(server, /beforeSendTransaction:/);
  assert.match(server, /beforeSendLog:/);
  assert.match(server, /nodeProfilingIntegration\(\)/);
  assert.match(server, /genAI: \{ inputs: false, outputs: false \}/);
  assert.match(edge, /beforeSendTransaction:/);
  assert.match(instrumentation, /onRequestError = Sentry\.captureRequestError/);
  assert.match(nextConfig, /tunnelRoute: "\/monitoring"/);
  assert.match(nextConfig, /value: "js-profiling"/);
  assert.doesNotMatch(nextConfig, /vercelCronsMonitoring: true/);
  assert.match(nextConfig, /NEXT_PUBLIC_SENTRY_DSN/);
  assert.match(middleware, /monitoring\(\?:\/\|\$\)/);
  assert.match(sentryCron, /Sentry\.captureCheckIn\(/);
  assert.match(sentryCron, /const status = response\.ok \? "ok" : "error"/);
  assert.match(sentryCron, /failureIssueThreshold: 2/);
  assert.match(sentryCron, /Sentry\.metrics\.count\("cron\.runs"/);
  assert.match(sentryCron, /Sentry\.logger\.error\(/);
  assert.match(sentryCron, /function observe\(/);
  assert.match(cronRoutes, /slug: "\/api\/cron\/warm"/);
  assert.match(cronRoutes, /slug: "\/api\/cron\/antifraud-containment-retry"/);
  assert.match(cronRoutes, /slug: "\/api\/cron\/reward-abuse-detection"/);
  assert.match(cronRoutes, /aliases: \["admin-cache-warm"\]/);
  assert.match(cronRoutes, /aliases: \["admin-antifraud-containment-retry"\]/);
  assert.match(cronRoutes, /aliases: \["admin-reward-abuse-detection"\]/);
});

test("Sentry sampling and request sanitization behavior stays bounded", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      [
        'const m = await import("./src/lib/sentry-config.ts");',
        "const event = m.sanitizeSentryEvent({",
        'request: { url: "https://packydash.com/users?id=secret#tab", headers: { cookie: "secret" }, cookies: { token: "secret" }, data: "secret", query_string: "id=secret", method: "GET" },',
        'user: { id: "secret" },',
        'exception: { values: [{ value: "failed for alice@example.com at https://example.com/a?token=secret", stacktrace: { frames: [{ vars: { secret: true } }] } }] },',
        'spans: [{ op: "db.query", description: "select * from users", data: { "db.query.text": "secret" } }],',
        '}, ["secret"]);',
        'console.log(JSON.stringify({ rates: [m.sentryTraceSampleRate(undefined), m.sentryTraceSampleRate("0"), m.sentryTraceSampleRate("1"), m.sentryTraceSampleRate("NaN"), m.sentryTraceSampleRate("2")], replayRates: [m.sentryReplayErrorSampleRate(undefined), m.sentryReplayErrorSampleRate("0"), m.sentryReplayErrorSampleRate("NaN")], profileRates: [m.sentryProfileSessionSampleRate(undefined), m.sentryProfileSessionSampleRate("0"), m.sentryProfileSessionSampleRate("1"), m.sentryProfileSessionSampleRate("NaN")], event }));',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);

  assert.deepEqual(result.rates, [0.1, 0, 1, 0.1, 0.1]);
  assert.deepEqual(result.replayRates, [1, 0, 1]);
  assert.deepEqual(result.profileRates, [0.01, 0, 1, 0.01]);
  assert.deepEqual(result.event, {
    request: { url: "https://packydash.com/users", method: "GET" },
    exception: {
      values: [
        {
          value: "failed for [Filtered email] at https://example.com/a",
          stacktrace: { frames: [{}] },
        },
      ],
    },
    spans: [{ op: "db.query" }],
  });
});
