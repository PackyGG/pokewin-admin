import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, sep } from "node:path";
import test from "node:test";

const root = process.cwd();
/** Sources are read with LF endings so the block regexes below stay portable. */
const read = (relative: string) =>
  readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");

const NETWORK_API = "src/lib/antifraud/network-api.ts";
const NETWORK_ROUTES = "services/antifraud-monitor/src/network-routes.ts";
const MONITOR_API = "src/lib/antifraud/monitor-api.ts";
const MONITOR_SERVER = "services/antifraud-monitor/src/server.ts";
const PACKY_ROUTE = "src/app/api/packy-live/route.ts";
const PACKY_CLIENT = "src/lib/packy-ws.ts";
const ENDPOINTS = "src/lib/api-auth/endpoints.ts";

/** Field names declared by a flat `z.object({ … })` literal body. */
function schemaKeys(block: string): string[] {
  return [...block.matchAll(/^\s*(\w+):\s*z\./gm)].map((match) => match[1]);
}

/** Field names declared by a flat inline TypeScript object type. */
function typeKeys(block: string): string[] {
  return [...block.matchAll(/^\s*(\w+)\??:/gm)].map((match) => match[1]);
}

test("PUT /v1/analysis-rules/:key — client body matches the service's strict schema", () => {
  const service = read(NETWORK_ROUTES);
  const client = read(NETWORK_API);

  const handler = service.match(
    /app\.put\("\/v1\/analysis-rules\/:key"[\s\S]*?const body = z\.object\(\{([\s\S]*?)\}\)\.strict\(\)/,
  );
  assert.ok(
    handler,
    "Could not find the strict body schema for PUT /v1/analysis-rules/:key — " +
      "if the service moved or dropped .strict(), update this guardrail.",
  );
  const serviceFields = schemaKeys(handler[1]);
  assert.ok(serviceFields.length > 0, "Service body schema parsed empty");

  const signature = client.match(
    /export async function updateAnalysisRule\(input:\s*\{([\s\S]*?)\n\}\)/,
  );
  assert.ok(signature, "updateAnalysisRule signature not found");
  const clientFields = typeKeys(signature[1]);

  // `key` is a PATH param on the service, never a body field. The service
  // schema is `.strict()`, so shipping it inside the body made Zod reject
  // EVERY rule save with a 400 `invalid_request`.
  assert.ok(
    clientFields.includes("key"),
    "updateAnalysisRule should still take `key` — it builds the path",
  );
  assert.deepEqual(
    clientFields.filter((field) => field !== "key").sort(),
    [...serviceFields].sort(),
    "The analysis-rule body the client sends no longer matches the service's " +
      "strict schema. Every save would 400.",
  );

  const body = client.match(
    /export async function updateAnalysisRule\([\s\S]*?\n\}\n/,
  )?.[0] ?? "";
  assert.match(
    body,
    /const \{ key, \.\.\.body \} = input;/,
    "`key` must be destructured OUT of the request body",
  );
  assert.match(
    body,
    /body: JSON\.stringify\(body\)/,
    "The PUT must send the key-stripped body, not the raw input",
  );
  assert.doesNotMatch(
    body,
    /body: JSON\.stringify\(input\)/,
    "Sending the raw input re-introduces the strict-schema rejection",
  );
  // The generic fallback string hid the service's real error code.
  assert.match(body, /z\.object\(\{ error: z\.string\(\) \}\)/);
});

test("network reads reject error envelopes before parsing them", () => {
  const client = read(NETWORK_API);

  for (const fn of ["getAccountNetwork", "getCreatorFraud"]) {
    const block =
      client.match(new RegExp(`export async function ${fn}\\([\\s\\S]*?\\n\\}\\n`))?.[0] ??
      "";
    assert.ok(block, `${fn} not found`);
    assert.match(
      block,
      /if \(!response\.ok\) \{\s*throw new Error\(`Monitor API returned \$\{response\.status\}`\);/,
      `${fn} must reject a non-2xx BEFORE parsing, or a 401/429/500 envelope ` +
        "fails the schema and looks identical to a slow service",
    );
    // 202 is a 2xx, so `response.ok` preserves the queued branch.
    assert.match(block, /queued: response\.status === 202/, `${fn} lost its queued branch`);
  }

  // The 404 "user does not exist" branch must still return BEFORE the guard.
  const account =
    client.match(/export async function getAccountNetwork\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(
    account.indexOf("response.status === 404") <
      account.indexOf("if (!response.ok)"),
    "getAccountNetwork's 404 branch must stay ahead of the ok-guard",
  );
});

test("409 responses are branched on the service's error code, not collapsed", () => {
  const service = read(MONITOR_SERVER);
  const client = read(MONITOR_API);

  // The service really does return these distinct 409 codes.
  for (const code of [
    "idempotency_conflict",
    "case_already_resolved",
    "rule_limit_reached",
    "duplicate_rule",
    "stale_rule",
  ]) {
    assert.match(
      service,
      new RegExp(`code\\(409\\)\\.send\\(\\{\\s*error: "${code}"`),
      `Service no longer returns a 409 ${code} — update the client branches`,
    );
  }

  const decision =
    client.match(/decision request failed[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(decision, "decision helper not found");
  assert.match(decision, /code === "idempotency_conflict"/);
  assert.match(decision, /That retry key was already used for a different decision/);
  assert.match(decision, /This case is already resolved\./);

  const rules =
    client.match(/async function mutateAntifraudRule\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(rules, "mutateAntifraudRule not found");
  for (const code of ["rule_limit_reached", "duplicate_rule", "stale_rule"]) {
    assert.match(
      rules,
      new RegExp(`code === "${code}"`),
      `mutateAntifraudRule must not report a 409 ${code} as a retry-key collision`,
    );
  }
});

test("packy-live refuses with a 2xx terminal stream, never a bare non-2xx", () => {
  const route = read(PACKY_ROUTE);

  // A non-2xx makes EventSource fail PERMANENTLY (readyState CLOSED, no
  // auto-retry), so capacity and backend refusals must be 200 SSE instead.
  assert.doesNotMatch(route, /status:\s*429/);
  assert.doesNotMatch(route, /status:\s*503/);
  // Auth bounces stay real HTTP statuses.
  assert.match(route, /new Response\("Unauthorized", \{ status: 401 \}\)/);
  assert.match(route, /new Response\("Forbidden", \{ status: 403 \}\)/);

  const terminal = route.match(/function terminalStream\([\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(terminal, "terminalStream helper not found");
  assert.match(terminal, /retry: \$\{retryMs\}/);
  assert.match(terminal, /frame\("upstream-error"/);
  assert.match(terminal, /fatal \? frame\("fatal"/);
  assert.match(terminal, /headers: SSE_HEADERS/);

  // Only the permanent refusal is fatal; the capacity refusal must keep the
  // browser's normal retry so the per-user counter can drain.
  assert.match(
    route,
    /terminalStream\(\s*"The live backend is unavailable\.",\s*CLIENT_RETRY_MS,\s*true,/,
  );
  assert.match(
    route,
    /terminalStream\(\s*"Too many live streams[^"]*",\s*CAPACITY_RETRY_MS,\s*\)/,
  );
});

test("packy-ws escalates, gives up and recovers instead of dying silently", () => {
  const client = read(PACKY_CLIENT);

  // Only a CLOSED EventSource is terminal; a CONNECTING one retries itself.
  assert.match(client, /es\.readyState !== EventSource\.CLOSED/);
  // Exponential backoff capped at 30s, mirroring use-sse.
  assert.match(client, /Math\.min\(30_000, 1000 \* 2 \*\* \(failures - 1\)\)/);
  assert.match(client, /const MAX_FAILURES = 8;/);
  assert.match(client, /failures >= MAX_FAILURES/);
  assert.match(client, /gaveUp = true/);
  // A server `fatal` frame stops the retry loop for good.
  assert.match(client, /es\.addEventListener\("fatal"/);
  // Recovery paths clear the give-up.
  assert.match(client, /window\.addEventListener\("online", handleOnline\)/);
  assert.match(client, /window\.addEventListener\("offline", handleOffline\)/);
  const online = client.match(/function handleOnline\(\)[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.match(online, /gaveUp = false/);

  // The visibility handler must drop a dead EventSource before reopening —
  // the old `!source` guard made a refocus a permanent no-op.
  const visibility =
    client.match(/function handleVisibility\(\)[\s\S]*?\n\}\n/)?.[0] ?? "";
  assert.ok(visibility, "handleVisibility not found");
  assert.match(visibility, /gaveUp = false/);
  assert.match(visibility, /source\.readyState === EventSource\.CLOSED/);
  assert.match(visibility, /closeSource\("manual"\)/);
});

test("every /api/v1 route appears in the API_ENDPOINTS catalogue", () => {
  const catalogue = read(ENDPOINTS);
  const base = join(root, "src/app/api/v1");

  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && entry.name === "route.ts" ? [full] : [];
    });

  const routes = walk(base)
    .map((file) =>
      "/api/v1" +
      file
        .slice(base.length, -"/route.ts".length)
        .split(sep)
        .join(posix.sep),
    )
    .sort();

  assert.ok(routes.length > 0, "No /api/v1 routes found — glob is broken");

  const documented = new Set(
    [...catalogue.matchAll(/path: "(\/api\/v1\/[^"]+)"/g)].map((m) => m[1]),
  );
  const missing = routes.filter((route) => !documented.has(route));
  assert.deepEqual(
    missing,
    [],
    "These live /api/v1 routes are missing from API_ENDPOINTS in " +
      `${ENDPOINTS}: ${missing.join(", ")}`,
  );

  const stale = [...documented].filter((path) => !routes.includes(path));
  assert.deepEqual(
    stale,
    [],
    `API_ENDPOINTS documents routes that no longer exist: ${stale.join(", ")}`,
  );
});
