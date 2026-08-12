import assert from "node:assert/strict";
import test from "node:test";

import {
  sanitizeSentryEvent,
  sentryProfileSessionSampleRate,
  sentryTraceSampleRate,
  stripUrlDetails,
} from "../src/sentry-config.js";

test("trace sampling is bounded and defaults conservatively", () => {
  assert.equal(sentryTraceSampleRate(undefined), 0.1);
  assert.equal(sentryTraceSampleRate("0.25"), 0.25);
  assert.equal(sentryTraceSampleRate("2"), 0.1);
  assert.equal(sentryTraceSampleRate("not-a-number"), 0.1);
});

test("profile sampling is bounded and defaults to one percent", () => {
  assert.equal(sentryProfileSessionSampleRate(undefined), 0.01);
  assert.equal(sentryProfileSessionSampleRate("0"), 0);
  assert.equal(sentryProfileSessionSampleRate("0.5"), 0.5);
  assert.equal(sentryProfileSessionSampleRate("2"), 0.01);
  assert.equal(sentryProfileSessionSampleRate("not-a-number"), 0.01);
});

test("Sentry events discard PII, query strings, request bodies, and secrets", () => {
  const event = sanitizeSentryEvent(
    {
      user: { id: "user-1", email: "private@example.com" },
      request: {
        url: "https://monitor.example.com/path?token=private#secret",
        query_string: "token=private",
        headers: { cookie: "session=private" },
        cookies: { session: "private" },
        data: { password: "private" },
      },
      message: "failed with super-secret",
      breadcrumbs: [{ message: "GET https://example.com/path?api_key=secret" }],
      spans: [
        {
          span_id: "0000000000000000",
          trace_id: "00000000000000000000000000000000",
          start_timestamp: 1,
          timestamp: 2,
          op: "db.query",
          description: "SELECT email FROM users",
          data: { "db.statement": "SELECT secret" },
        },
      ],
      extra: { authorization: "Bearer private", safe: "super-secret" },
      exception: {
        values: [
          {
            value: "postgresql://super-secret@db failed",
            stacktrace: {
              frames: [
                { filename: "server.js", vars: { password: "private" } },
              ],
            },
          },
        ],
      },
    },
    ["super-secret"],
  );

  assert.equal(event.user, undefined);
  assert.equal(event.request?.url, "https://monitor.example.com/path");
  assert.equal(event.request?.query_string, undefined);
  assert.equal(event.request?.headers, undefined);
  assert.equal(event.request?.cookies, undefined);
  assert.equal(event.request?.data, undefined);
  assert.equal(event.message, "failed with [Filtered]");
  assert.equal(
    event.exception?.values?.[0]?.value,
    "postgresql://[Filtered]@db failed",
  );
  assert.equal(
    event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars,
    undefined,
  );
  assert.equal(event.breadcrumbs?.[0]?.message, "GET https://example.com/path");
  assert.equal(event.spans?.[0]?.description, undefined);
  assert.equal(event.spans?.[0]?.data, undefined);
  assert.equal(event.extra?.authorization, undefined);
  assert.equal(event.extra?.safe, "[Filtered]");
  assert.equal(stripUrlDetails("/path?secret=yes#hash"), "/path");
});
