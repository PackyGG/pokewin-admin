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
  assert.ok(boundaries.length >= 39, "expected the complete boundary inventory");

  for (const path of boundaries) {
    const source = read(path);
    if (/export \{ default \} from/.test(source)) continue;
    assert.match(source, /reportWebappError\(/, `${path} must report its error`);
  }
});

test("Sentry initializes all Next.js runtimes with privacy and tracing guards", () => {
  const client = read("src/instrumentation-client.ts");
  const server = read("src/sentry.server.config.ts");
  const edge = read("src/sentry.edge.config.ts");
  const instrumentation = read("src/instrumentation.ts");
  const nextConfig = read("next.config.ts");
  const middleware = read("src/middleware.ts");

  assert.match(client, /Sentry\.init\(/);
  assert.doesNotMatch(client, /import\("@sentry\/nextjs"\)/);
  assert.match(client, /beforeSend: sanitizeSentryEvent/);
  assert.match(client, /onRouterTransitionStart = Sentry\.captureRouterTransitionStart/);
  assert.match(server, /beforeSend: sanitizeSentryEvent/);
  assert.match(edge, /beforeSend: sanitizeSentryEvent/);
  assert.match(instrumentation, /onRequestError = Sentry\.captureRequestError/);
  assert.match(nextConfig, /tunnelRoute: "\/monitoring"/);
  assert.match(nextConfig, /NEXT_PUBLIC_SENTRY_DSN/);
  assert.match(middleware, /monitoring\(\?:\/\|\$\)/);
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
        "});",
        'console.log(JSON.stringify({ rates: [m.sentryTraceSampleRate(undefined), m.sentryTraceSampleRate("0"), m.sentryTraceSampleRate("1"), m.sentryTraceSampleRate("NaN"), m.sentryTraceSampleRate("2")], event }));',
      ].join("\n"),
    ],
    { encoding: "utf8" },
  );
  const result = JSON.parse(output);

  assert.deepEqual(result.rates, [0.1, 0, 1, 0.1, 0.1]);
  assert.deepEqual(result.event, {
    request: { url: "https://packydash.com/users", method: "GET" },
  });
});
