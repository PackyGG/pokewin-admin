import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actionsPath = "src/app/(admin)/packs/actions.ts";
const builderPagePath =
  "src/app/(pack-studio)/pack-studio/builder/page.tsx";
const approvalPagePath = "src/app/(admin)/system/new-packs/page.tsx";
const migrationPath =
  "drizzle/admin/migrations/20260726_pack_creation_approval_queue.sql";

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

  assert.match(approvalPage, /sessionIsOwner\(session\)/);
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
