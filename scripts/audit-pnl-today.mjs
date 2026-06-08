/**
 * Read-only audit: verify windowed P&L components sum to the headline total.
 * Run: node scripts/audit-pnl-today.mjs
 *
 * Standalone (pg + dotenv) — does not import server-only Next modules.
 */
import pg from "pg";
import dotenv from "dotenv";

dotenv.config({ path: ".env" });

const statsExcluded =
  "lt.type::text = 'admin_balance_adjustment' AND lt.metadata->>'adjustment_category' IN ('official_stream','remove_locked_balance')";

function adminInventoryRemovalDisposedSql(sinceBind, scopedUserId) {
  return `COALESCE((
    SELECT SUM(ABS(lt.amount::numeric))
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.created_at >= ${sinceBind}
      AND lt.type::text = 'admin_balance_adjustment'
      AND lt.metadata->>'kind' = 'inventory_removal'
      AND ${scopedUserId}
      AND NOT EXISTS (
        SELECT 1 FROM user_inventory ui2
        WHERE ui2.id::text = lt.metadata->>'inventory_item_id'
      )
  ), 0)`;
}

function adminVoucherRemovalClaimedSql(sinceBind, scopedUserId) {
  return `COALESCE((
    SELECT SUM(ABS(lt.amount::numeric))
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.created_at >= ${sinceBind}
      AND lt.type::text = 'admin_balance_adjustment'
      AND lt.metadata->>'kind' = 'voucher_removal'
      AND ${scopedUserId}
      AND NOT EXISTS (
        SELECT 1 FROM vouchers v2
        WHERE v2.id::text = lt.metadata->>'voucher_id'
      )
  ), 0)`;
}

async function main() {
  const admin = new pg.Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  const mainDb = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  await mainDb.connect();

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();

  const ex = await admin.query("SELECT user_id FROM excluded_users");
  const excluded = ex.rows.map((r) => r.user_id);
  const escapeId = (id) => `'${id.replace(/'/g, "''")}'`;
  const blacklist =
    excluded.length > 0
      ? `AND u.id NOT IN (${excluded.map(escapeId).join(",")})`
      : "";
  const scope = (col) =>
    `${col} IN (SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support') ${blacklist})`;
  const excludedOnlyScope = (col) =>
    excluded.length > 0
      ? `${col} IN (${excluded.map(escapeId).join(",")})`
      : `${col} IN (SELECT id FROM "user" WHERE false)`;
  const userScopeLt = scope("lt.user_id");
  const excludedUserScopeLt = excludedOnlyScope("lt.user_id");

  const [ledger, card, inv, vch] = await Promise.all([
    mainDb.query(
      `SELECT
         COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS deposits,
         COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                            AND lt.balance_after < lt.balance_before
                            AND lt.description ILIKE 'Manual withdrawal:%'
                           THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS manual_wd,
         COALESCE(SUM(CASE WHEN ${statsExcluded} THEN 0 ELSE (lt.balance_after - lt.balance_before)::numeric END), 0)::float8 AS balance_change
       FROM ledger_transactions lt
       WHERE lt.status = 'completed' AND lt.created_at >= $1 AND ${userScopeLt}`,
      [sinceIso],
    ),
    mainDb.query(
      `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::float8 AS card_wd
       FROM card_withdrawal_requests cwr
       WHERE cwr.status IN ('completed', 'shipped')
         AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $1
         AND ${scope("cwr.user_id")}`,
      [sinceIso],
    ),
    mainDb.query(
      `SELECT
         COALESCE(SUM(CASE WHEN ui.obtained_at >= $1 THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::float8 AS obtained,
         (
           COALESCE(SUM(CASE WHEN (ui.sold_at >= $1 OR ui.exchanged_at >= $1) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)
           + ${adminInventoryRemovalDisposedSql("$1", userScopeLt)}
         )::float8 AS disposed
       FROM user_inventory ui
       WHERE (ui.obtained_at >= $1 OR ui.sold_at >= $1 OR ui.exchanged_at >= $1)
         AND ${scope("ui.user_id")}`,
      [sinceIso],
    ),
    mainDb.query(
      `SELECT
         COALESCE(SUM(CASE WHEN v.created_at >= $1 THEN v.value::numeric ELSE 0 END), 0)::float8 AS issued,
         (
           COALESCE(SUM(CASE WHEN v.claimed_at >= $1 THEN v.value::numeric ELSE 0 END), 0)
           + ${adminVoucherRemovalClaimedSql("$1", userScopeLt)}
         )::float8 AS claimed
       FROM vouchers v
       WHERE (v.created_at >= $1 OR v.claimed_at >= $1)
         AND ${scope("v.user_id")}`,
      [sinceIso],
    ),
  ]);

  const deposits = ledger.rows[0].deposits;
  const manualWd = ledger.rows[0].manual_wd;
  const cardWd = card.rows[0].card_wd;
  const withdrawalsGross = Math.abs(manualWd) + cardWd;
  const balanceChange = ledger.rows[0].balance_change;
  const inventoryChange = inv.rows[0].obtained - inv.rows[0].disposed;
  const voucherChange = vch.rows[0].issued - vch.rows[0].claimed;
  const pnl =
    deposits - (manualWd + cardWd) - balanceChange - inventoryChange - voucherChange;
  const popoverPnl =
    deposits - withdrawalsGross - balanceChange - inventoryChange - voucherChange;
  const ok = Math.abs(popoverPnl - pnl) < 0.01;

  // Exclusion leak check: compute today's P&L for excluded users only.
  // Headline `pnl` must NOT include this activity — if excluded users had
  // any today volume, `excludedOnlyPnl` is non-zero but absent from headline.
  let excludedOnlyPnl = 0;
  let excludedOnlyDeposits = 0;
  if (excluded.length > 0) {
    const [exLedger, exCard, exInv, exVch] = await Promise.all([
      mainDb.query(
        `SELECT
           COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS deposits,
           COALESCE(SUM(CASE WHEN lt.type::text = 'admin_balance_adjustment'
                              AND lt.balance_after < lt.balance_before
                              AND lt.description ILIKE 'Manual withdrawal:%'
                             THEN lt.amount::numeric ELSE 0 END), 0)::float8 AS manual_wd,
           COALESCE(SUM(CASE WHEN ${statsExcluded} THEN 0 ELSE (lt.balance_after - lt.balance_before)::numeric END), 0)::float8 AS balance_change
         FROM ledger_transactions lt
         WHERE lt.status = 'completed' AND lt.created_at >= $1 AND ${excludedUserScopeLt}`,
        [sinceIso],
      ),
      mainDb.query(
        `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::float8 AS card_wd
         FROM card_withdrawal_requests cwr
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.shipped_at, cwr.completed_at) >= $1
           AND ${excludedOnlyScope("cwr.user_id")}`,
        [sinceIso],
      ),
      mainDb.query(
        `SELECT
           COALESCE(SUM(CASE WHEN ui.obtained_at >= $1 THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::float8 AS obtained,
           (
             COALESCE(SUM(CASE WHEN (ui.sold_at >= $1 OR ui.exchanged_at >= $1) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)
             + ${adminInventoryRemovalDisposedSql("$1", excludedUserScopeLt)}
           )::float8 AS disposed
         FROM user_inventory ui
         WHERE (ui.obtained_at >= $1 OR ui.sold_at >= $1 OR ui.exchanged_at >= $1)
           AND ${excludedOnlyScope("ui.user_id")}`,
        [sinceIso],
      ),
      mainDb.query(
        `SELECT
           COALESCE(SUM(CASE WHEN v.created_at >= $1 THEN v.value::numeric ELSE 0 END), 0)::float8 AS issued,
           (
             COALESCE(SUM(CASE WHEN v.claimed_at >= $1 THEN v.value::numeric ELSE 0 END), 0)
             + ${adminVoucherRemovalClaimedSql("$1", excludedUserScopeLt)}
           )::float8 AS claimed
         FROM vouchers v
         WHERE (v.created_at >= $1 OR v.claimed_at >= $1)
           AND ${excludedOnlyScope("v.user_id")}`,
        [sinceIso],
      ),
    ]);
    excludedOnlyDeposits = exLedger.rows[0].deposits;
    const exManualWd = exLedger.rows[0].manual_wd;
    const exCardWd = exCard.rows[0].card_wd;
    const exBalanceChange = exLedger.rows[0].balance_change;
    const exInventoryChange = exInv.rows[0].obtained - exInv.rows[0].disposed;
    const exVoucherChange = exVch.rows[0].issued - exVch.rows[0].claimed;
    excludedOnlyPnl =
      excludedOnlyDeposits -
      (exManualWd + exCardWd) -
      exBalanceChange -
      exInventoryChange -
      exVoucherChange;
  }

  const exclusionLeakCheck = {
    excludedOnlyPnl,
    excludedOnlyDeposits,
    excludedActivityPresentToday: Math.abs(excludedOnlyPnl) > 0.01,
    headlineExcludesExcludedUsers: true,
  };

  console.log(
    JSON.stringify(
      {
        windowStartUtc: sinceIso,
        excludedUsers: excluded.length,
        deposits,
        manualWd,
        cardWd,
        withdrawalsGross,
        balanceChange,
        inventoryChange,
        voucherChange,
        pnl,
        netHoldingsChange: balanceChange + inventoryChange + voucherChange,
        naiveDepositsMinusWithdrawals: deposits - withdrawalsGross,
        popoverFormulaPnl: popoverPnl,
        formulaReconciles: ok,
        exclusionLeakCheck,
      },
      null,
      2,
    ),
  );

  await admin.end();
  await mainDb.end();
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
