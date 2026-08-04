import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actionsPath = "src/app/(admin)/packs/actions.ts";
const builderPagePath =
  "src/app/(pack-studio)/pack-studio/builder/page.tsx";
const approvalPagePath =
  "src/app/(pack-studio)/pack-studio/new-packs/page.tsx";
const approvalListPath =
  "src/app/(pack-studio)/pack-studio/new-packs/review-list.tsx";
const buildDraftsPagePath =
  "src/app/(pack-studio)/pack-studio/builder-drafts/page.tsx";
const buildDraftsListPath =
  "src/app/(pack-studio)/pack-studio/builder-drafts/build-drafts-list.tsx";
const sidebarPath =
  "src/app/(pack-studio)/pack-studio/_components/pack-studio-sidebar.tsx";
const navPath = "src/lib/nav-config.ts";
const appHostsPath = "src/lib/app-hosts.ts";
const packStudioLayoutPath =
  "src/app/(pack-studio)/pack-studio/layout.tsx";
const migrationPath =
  "drizzle/admin/migrations/20260726_pack_creation_approval_queue.sql";
const builderFormPath =
  "src/app/(pack-studio)/pack-studio/builder/pack-builder-form.tsx";
const builderDraftDataPath =
  "src/app/(pack-studio)/pack-studio/builder/draft-data.ts";
const buildRequestsPath = "src/lib/packs/build-requests.ts";
const builderEdgePath = "src/lib/packs/builder-edge.ts";
const serverLayoutPaths = [
  "src/app/(admin)/layout.tsx",
  "src/app/(creator-hub)/creator-hub/layout.tsx",
  "src/app/(pack-studio)/pack-studio/layout.tsx",
  "src/app/(antifraud)/antifraud/layout.tsx",
] as const;

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

test("inactive Pack Builder saves land on Saved Builds without owner approval", async () => {
  const [
    actions,
    builderForm,
    buildDraftsPage,
    buildDraftsList,
    buildRequests,
    approvalPage,
    sidebar,
    appHosts,
  ] = await Promise.all([
    readFile(actionsPath, "utf8"),
    readFile(builderFormPath, "utf8"),
    readFile(buildDraftsPagePath, "utf8"),
    readFile(buildDraftsListPath, "utf8"),
    readFile(buildRequestsPath, "utf8"),
    readFile(approvalPagePath, "utf8"),
    readFile(sidebarPath, "utf8"),
    readFile(appHostsPath, "utf8"),
  ]);

  assert.match(builderForm, /Save build draft/);
  assert.match(builderForm, /router\.push\(/);
  assert.match(builderForm, /\/pack-studio\/builder-drafts/);
  assert.match(
    buildDraftsPage,
    /const session = await requirePackStudioPageAccess\(\)/,
  );
  assert.match(buildDraftsPage, /listPackBuildDrafts/);
  assert.match(buildDraftsPage, /sessionHasRole\(session, "admin"\)/);
  assert.match(buildDraftsPage, /const requestedBy = canManageAll \? null : session\.userId/);
  assert.match(buildDraftsPage, /getCachedBuildDrafts\(requestedBy\)/);
  assert.match(buildRequests, /requested_active = false/);
  assert.match(
    buildRequests,
    /AND r\.requested_by = \$\{input\.requestedBy\}::uuid/,
  );
  assert.match(buildDraftsList, /Request live approval/);
  assert.match(buildDraftsList, /discardPackBuildDraftAction/);
  assert.match(approvalPage, /requests\.filter\(\(request\) => request\.requestedActive\)/);
  assert.match(sidebar, /label:\s*"Saved Builds"[\s\S]*?\/pack-studio\/builder-drafts/);
  assert.match(appHosts, /"builder-drafts"/);

  const buildAction = actions.slice(
    actions.indexOf("export async function buildPack"),
    actions.indexOf("export type ApprovePackCreationResult"),
  );
  assert.match(buildAction, /unstable_rethrow\(error\)/);
  assert.match(buildAction, /ok:\s*false/);
});

test("live Pack Builder requests require artwork while saved drafts remain allowed", async () => {
  const [
    actions,
    builderForm,
    buildDraftsPage,
    buildDraftsList,
    buildRequests,
    approvalList,
  ] = await Promise.all([
    readFile(actionsPath, "utf8"),
    readFile(builderFormPath, "utf8"),
    readFile(buildDraftsPagePath, "utf8"),
    readFile(buildDraftsListPath, "utf8"),
    readFile(buildRequestsPath, "utf8"),
    readFile(approvalListPath, "utf8"),
  ]);

  assert.match(buildRequests, /storedBuildPackRequestSchema\.superRefine/);
  assert.match(
    buildRequests,
    /request\.activate === true && !request\.imageUrl/,
  );
  assert.match(
    buildRequests,
    /Drafts can be saved without one/,
  );
  assert.match(
    buildRequests,
    /NULLIF\(BTRIM\(request_payload->>'imageUrl'\), ''\) IS NOT NULL/,
  );
  assert.match(buildRequests, /return "submitted"/);
  assert.match(buildRequests, /"missing_image"/);
  assert.match(buildRequests, /updatePackBuildDraftImage/);

  assert.match(
    builderForm,
    /canSubmit && \(imageFile !== null \|\| imagePreview !== null\)/,
  );
  assert.match(
    builderForm,
    /activate && imageFile === null && imagePreview === null/,
  );
  assert.match(builderForm, /disabled=\{!canRequestLive\}/);
  assert.match(builderForm, /Optional for saved drafts/);
  assert.match(builderForm, /handleSubmit\(false\)/);

  assert.match(buildDraftsPage, /imageUrl:\s*draft\.requestPayload\.imageUrl \?\? null/);
  assert.match(buildDraftsList, /updatePackBuildDraftImageAction/);
  assert.match(buildDraftsList, /Add image/);
  assert.match(
    buildDraftsList,
    /isPending \|\| !draft\.imageUrl \|\| !edgeWithinProductionBand/,
  );
  assert.match(approvalList, /Image required/);
  assert.match(
    approvalList,
    /isPending \|\| !item\.imageUrl \|\| !edgeWithinProductionBand/,
  );

  const materialize = actions.slice(
    actions.indexOf("async function materializeApprovedPack"),
    actions.indexOf("async function previewPackBuildRequest"),
  );
  assert.match(
    materialize,
    /if \(!parsed\.success\) \{[\s\S]*?ok:\s*false/,
  );
  const approval = actions.slice(
    actions.indexOf("export async function approvePackCreationRequest"),
    actions.indexOf("export async function declinePackCreationRequestAction"),
  );
  assert.match(approval, /if \(!result\.ok\) \{[\s\S]*?releasePackCreationRequest/);
});

test("saved Pack Builder drafts can be edited in place", async () => {
  const [
    actions,
    builderPage,
    builderForm,
    buildDraftsList,
    buildRequests,
    draftData,
  ] = await Promise.all([
    readFile(actionsPath, "utf8"),
    readFile(builderPagePath, "utf8"),
    readFile(builderFormPath, "utf8"),
    readFile(buildDraftsListPath, "utf8"),
    readFile(buildRequestsPath, "utf8"),
    readFile(builderDraftDataPath, "utf8"),
  ]);

  assert.match(buildDraftsList, /Edit build/);
  assert.match(buildDraftsList, /\/pack-studio\/builder\?draft=/);
  assert.match(builderPage, /searchParams:\s*Promise/);
  assert.match(builderPage, /loadPackBuilderDraft/);
  assert.match(builderForm, /initialDraft/);
  assert.match(builderForm, /Update build draft/);
  assert.match(actions, /updatePackBuildDraft/);
  assert.match(actions, /pack_build_draft_updated/);
  assert.match(buildRequests, /export async function getPackBuildDraftForEdit/);
  assert.match(buildRequests, /export async function updatePackBuildDraft/);
  assert.match(
    buildRequests,
    /requested_by = \$\{input\.actorId\}::uuid[\s\S]*?OR \$\{input\.canManageAll\}/,
  );
  assert.match(draftData, /WHERE id = ANY/);
  assert.match(draftData, /getReadDrizzleDb/);
});

test("saved Pack Builder drafts preserve and restore their exact odds", async () => {
  const [actions, builderForm, buildRequests, draftData] = await Promise.all([
    readFile(actionsPath, "utf8"),
    readFile(builderFormPath, "utf8"),
    readFile(buildRequestsPath, "utf8"),
    readFile(builderDraftDataPath, "utf8"),
  ]);

  assert.match(builderForm, /ticketWeights:\s*cards\.map\(\(c\) => oddsPercentToUnits\(c\.odds\)\)/);
  assert.match(buildRequests, /ticketWeights:\s*z\.array\(z\.number\(\)\.int\(\)\.nonnegative\(\)\)\.optional\(\)/);
  assert.match(buildRequests, /hasExactPackBuilderTicketTotal\(request\.ticketWeights\)/);
  assert.match(draftData, /draft\.requestPayload\.ticketWeights \?\?/);
  assert.match(draftData, /odds:\s*ticketWeights\[index\]! \/ 10_000/);
  assert.equal(
    actions.match(/resolvePackBuildTickets\(/g)?.length,
    3,
    "the shared exact-odds resolver must be defined and used by preview plus approval",
  );
  assert.match(actions, /tickets:\s*\[\.\.\.input\.ticketWeights\]/);
});

test("the normal Packs dashboard has no pack edit entry point", async () => {
  const [page, detailPage, detailView, rowActions] = await Promise.all([
    readFile("src/app/(admin)/packs/page.tsx", "utf8"),
    readFile("src/app/(admin)/packs/[id]/page.tsx", "utf8"),
    readFile("src/app/(admin)/packs/pack-detail-view.tsx", "utf8"),
    readFile("src/app/(admin)/packs/pack-row-actions.tsx", "utf8"),
  ]);

  for (const source of [page, detailPage, detailView, rowActions]) {
    assert.doesNotMatch(source, /PackEditForm|\?edit=1|Edit pack|initialViewMode/);
  }
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

test("Pack Builder production enforces exact tickets and the 10.95% to 11.50% edge band", async () => {
  const [
    actions,
    builderForm,
    buildDraftsList,
    approvalList,
    buildRequests,
    builderEdge,
  ] = await Promise.all([
    readFile(actionsPath, "utf8"),
    readFile(builderFormPath, "utf8"),
    readFile(buildDraftsListPath, "utf8"),
    readFile(approvalListPath, "utf8"),
    readFile(buildRequestsPath, "utf8"),
    readFile(builderEdgePath, "utf8"),
  ]);

  assert.match(builderEdge, /PACK_BUILDER_EDGE_MIN = 0\.1095/);
  assert.match(builderEdge, /PACK_BUILDER_EDGE_MAX = 0\.115/);
  assert.match(builderEdge, /PACK_BUILDER_TICKET_TOTAL = 1_000_000/);
  assert.match(buildRequests, /isPackBuilderEdgeInRange\(request\.targets\.targetEdge\)/);
  assert.match(builderForm, /clampPackBuilderEdge\(/);
  assert.match(builderForm, /isPackBuilderEdgeInRange\(/);
  assert.match(actions, /getPackBuilderEdgeError\(risk\.edge\)/);
  assert.match(actions, /getPackBuilderEdgeError\(shaped\.risk\.edge\)/);
  assert.equal(
    actions.match(/getPackBuilderTicketTotalError\(/g)?.length,
    4,
    "stored odds, compatibility solve, owner write, and persisted rows must require exact ticket mass",
  );
  assert.match(
    actions,
    /getPackBuilderTicketTotalError\(\s*cardRows\.map\(\(row\) => row\.weight\)/,
  );
  assert.match(buildDraftsList, /!edgeWithinProductionBand/);
  assert.match(approvalList, /!edgeWithinProductionBand/);
});

test("New Packs max win is the highest-priced item in the requested pool", async () => {
  const actions = await readFile(actionsPath, "utf8");
  const preview = actions.slice(
    actions.indexOf("async function previewPackBuildRequest"),
    actions.indexOf("/**\n * Validate a Pack Studio build"),
  );

  assert.match(
    preview,
    /const poolMaxWin = slots\.reduce\([\s\S]*?Math\.max\(highest, slot\.value\)/,
  );
  assert.match(preview, /maxWin:\s*poolMaxWin/);
  assert.doesNotMatch(preview, /maxWin:\s*shaped\.risk\.maxWin/);
});

test("Pack Approval Queue lives only in the owner-only Packs System section", async () => {
  const [approvalPage, sidebar, nav, appHosts] = await Promise.all([
    readFile(approvalPagePath, "utf8"),
    readFile(sidebarPath, "utf8"),
    readFile(navPath, "utf8"),
    readFile(appHostsPath, "utf8"),
  ]);

  assert.match(approvalPage, /await requireOwner\(\)/);
  assert.match(sidebar, /label:\s*"Approval Queue"[\s\S]*?\/pack-studio\/new-packs/);
  assert.match(
    sidebar,
    /\{isOwner\s*&&\s*\([\s\S]*?<SidebarGroupLabel>System<\/SidebarGroupLabel>/,
  );
  assert.doesNotMatch(nav, /nav\.system\.new-packs|href:\s*"\/system\/new-packs"/);
  assert.match(appHosts, /segmentRoutes:\s*\[[\s\S]*?"new-packs"/);
});

test("New Packs shows submitted artwork and the player-facing risk bar", async () => {
  const [approvalPage, approvalList] = await Promise.all([
    readFile(approvalPagePath, "utf8"),
    readFile(approvalListPath, "utf8"),
  ]);

  assert.match(
    approvalPage,
    /imageUrl:\s*request\.requestPayload\.imageUrl \?\? null/,
  );
  assert.match(approvalList, /<CardImage[\s\S]*?src=\{item\.imageUrl\}/);
  assert.match(approvalList, /<PackRiskBarPreview/);
  assert.match(approvalList, /\{riskScore\}\/100/);
});

test("Pack Studio pages use descriptive Pack Studio browser titles", async () => {
  const [layout, builderPage, buildDraftsPage, approvalPage] =
    await Promise.all([
      readFile(packStudioLayoutPath, "utf8"),
      readFile(builderPagePath, "utf8"),
      readFile(buildDraftsPagePath, "utf8"),
      readFile(approvalPagePath, "utf8"),
    ]);

  assert.match(layout, /template:\s*"%s · Pack Studio"/);
  assert.match(builderPage, /title:\s*"Pack Builder"/);
  assert.match(buildDraftsPage, /title:\s*"Saved Pack Builds"/);
  assert.match(approvalPage, /title:\s*"Pack Approval Queue"/);
});

test("server layouts rethrow Next render control flow instead of swallowing it", async () => {
  const layouts = await Promise.all(
    serverLayoutPaths.map((path) => readFile(path, "utf8")),
  );
  for (const layout of layouts) {
    assert.match(layout, /unstable_rethrow\(err\)/);
    assert.doesNotMatch(layout, /isNextControlFlowError/);
  }
});
