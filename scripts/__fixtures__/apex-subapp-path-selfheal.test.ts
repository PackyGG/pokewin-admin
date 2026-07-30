// =============================================================================
// Apex → sub-app path self-heal (src/lib/app-hosts.ts).
//
// `packydash.com/banned-users` used to 404: the apex is a LANDING host, so it
// never rewrites into a segment, and the main admin app has no such route — the
// page only exists at `fraud.packydash.com/banned-users`. The middleware already
// self-healed the opposite direction (a main-app path opened on a segment host);
// this guards the mirror image, plus the one thing that could make it dangerous:
// a sub-app claiming a segment the apex owns itself (`/packs`, `/creators`,
// `/rewards`, `/settings`) must NEVER be redirected off the apex.
// =============================================================================

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { APP_HOSTS, redirectTargetForHost } from "@/lib/app-hosts";

const root = process.cwd();
const apex = APP_HOSTS[0];

function hostFor(basePath: string): string {
  const host = APP_HOSTS.find((entry) => entry.basePath === basePath)?.host;
  assert.ok(host, `no host owns ${basePath}`);
  return host;
}

test("a sub-app path on the apex redirects to its owning host", () => {
  assert.equal(
    redirectTargetForHost(apex, "/banned-users"),
    `https://${hostFor("/antifraud")}/banned-users`,
  );
  assert.equal(
    redirectTargetForHost(apex, "/reviews/abc123"),
    `https://${hostFor("/antifraud")}/reviews/abc123`,
  );
  assert.equal(
    redirectTargetForHost(apex, "/doctor"),
    `https://${hostFor("/pack-studio")}/doctor`,
  );
  assert.equal(
    redirectTargetForHost(apex, "/leaderboards"),
    `https://${hostFor("/creator-hub")}/leaderboards`,
  );
});

test("apex-owned and shared segments stay on the apex", () => {
  for (const pathname of [
    "/",
    "/dashboard",
    "/users/42",
    "/packs",
    "/cards",
    "/creators",
    "/rewards",
    "/settings",
    "/profile",
    "/notifications",
    "/withdrawals",
    "/login",
    "/api/packy-live",
  ]) {
    assert.equal(
      redirectTargetForHost(apex, pathname),
      null,
      `${pathname} must keep rendering on the apex`,
    );
  }
});

test("every apex route directory is listed in APEX_ROUTE_SEGMENTS", () => {
  const source = readFileSync(join(root, "src/lib/app-hosts.ts"), "utf8");
  const block =
    source.match(
      /APEX_ROUTE_SEGMENTS: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/,
    )?.[1] ?? "";
  const listed = new Set(
    [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
  assert.ok(listed.size > 0, "APEX_ROUTE_SEGMENTS not found");

  const dirs = readdirSync(join(root, "src/app/(admin)"), {
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith("_") &&
        !entry.name.startsWith("("),
    )
    .map((entry) => entry.name);
  assert.ok(dirs.length > 0, "no apex route directories found");

  for (const dir of dirs) {
    assert.ok(
      listed.has(dir),
      `/${dir} is an apex route but missing from APEX_ROUTE_SEGMENTS — a sub-app claiming the same segment would hijack it`,
    );
  }
});
