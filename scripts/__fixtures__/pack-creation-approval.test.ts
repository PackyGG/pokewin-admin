import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actionsPath = "src/app/(admin)/packs/actions.ts";
const builderPagePath =
  "src/app/(pack-studio)/pack-studio/builder/page.tsx";
const approvalPagePath =
  "src/app/(pack-studio)/pack-studio/new-packs/page.tsx";
const sidebarPath =
  "src/app/(pack-studio)/pack-studio/_components/pack-studio-sidebar.tsx";
const navPath = "src/lib/nav-config.ts";
const appHostsPath = "src/lib/app-hosts.ts";
const migrationPath =
  "drizzle/admin/migrations/20260726_pack_creation_approval_queue.sql";
const builderFormPath =
  "src/app/(pack-studio)/pack-studio/builder/pack-builder-form.tsx";
const buildRequestsPath = "src/lib/packs/build-requests.ts";

test("Pack Builder submissions queue before any approved MAIN write", async () => {
  const [actions, builderPage, approvalPage, migration] = await Promise.all([
    readFile(actionsPath, "utf8"),
    readFile(builderPagePath, "utf8"),
    readFile(approvalPagePath, "utf8"),
    readFile(migrationPath, "utf8"),
  ]);

  const queueAction = actions.slice(
    actions.indexOf("export async function buildPack"),
    actions.indexOf("export type ApprovePackCreationResult"),
  );
  assert.match(queueAction, /enqueuePackCreationRequest/);
  assert.doesNotMatch(queueAction, /insertBuiltPack|INSERT INTO packs/);
  assert.match(builderPage, /sessionHasRole\(session, "pack_creator"\)/);

  assert.match(approvalPage, /await requireOwner\(\)/);
  assert.match(actions, /export async function approvePackCreationRequest/);
  assert.match(actions, /claimPackCreationRequest/);
  assert.match(actions, /materializeApprovedPack/);
  assert.match(actions, /completePackCreationRequest/);

  const approvalActions = actions.slice(
    actions.indexOf("export async function approvePackCreationRequest"),
  );
  assert.doesNotMatch(approvalActions, /require2FA|verify.*totp|authorize.*2fa/i);

  assert.match(
    actions,
    /Pack Builders must request a live push through Pack Studio for owner approval/,
  );
  assert.match(
    migration,
    /CHECK \(status IN \('pending', 'processing', 'approved', 'declined'\)\)/,
  );
  assert.match(migration, /pack_creation_requests_pending_slug_key/);
});

test("Pack Builder preserves card color and animation through owner approval", async () => {
  const [actions, builderForm, buildRequests] = await Promise.all([
    readFile(actionsPath, "utf8"),
    readFile(builderFormPath, "utf8"),
    readFile(buildRequestsPath, "utf8"),
  ]);

  assert.match(builderForm, /color:\s*c\.color/);
  assert.match(builderForm, /animation:\s*c\.animation/);
  assert.match(buildRequests, /color:\s*packCardColorSchema/);
  assert.match(buildRequests, /animation:\s*z\.boolean\(\)\.optional\(\)/);

  const materialize = actions.slice(
    actions.indexOf("async function materializeApprovedPack"),
    actions.indexOf("async function previewPackBuildRequest"),
  );
  assert.match(materialize, /color:\s*c\.color \?\? null/);
  assert.match(materialize, /animation:\s*c\.animation \?\? false/);
  assert.match(materialize, /color:\s*s\.color/);
  assert.match(materialize, /animation:\s*s\.animation/);
});

test("New Packs lives only in the owner-only Packs System section", async () => {
  const [approvalPage, sidebar, nav, appHosts] = await Promise.all([
    readFile(approvalPagePath, "utf8"),
    readFile(sidebarPath, "utf8"),
    readFile(navPath, "utf8"),
    readFile(appHostsPath, "utf8"),
  ]);

  assert.match(approvalPage, /await requireOwner\(\)/);
  assert.match(sidebar, /label:\s*"New Packs".*\/pack-studio\/new-packs/);
  assert.match(
    sidebar,
    /\{isOwner\s*&&\s*\([\s\S]*?<SidebarGroupLabel>System<\/SidebarGroupLabel>/,
  );
  assert.doesNotMatch(nav, /nav\.system\.new-packs|href:\s*"\/system\/new-packs"/);
  assert.match(appHosts, /segmentRoutes:\s*\[[\s\S]*?"new-packs"/);
});
