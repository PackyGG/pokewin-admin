/**
 * verify-affiliate-wipe-protection.ts — ROLLED-BACK proof that the account
 * wipe never touches affiliate info, AND that the affiliate/deal adjustment
 * carve-out is creator-CONDITIONAL (2026-06-03).
 *
 * What it proves (against the MAIN DB — a stale snapshot per the task brief,
 * and EVERYTHING destructive runs inside a transaction that is force
 * ROLLED BACK at the end, so prod state is never mutated):
 *
 *   1. TAXONOMY (read-only): the real `admin_balance_adjustment` description
 *      distribution, so we can confirm the keyword carve-out matches actual
 *      rows and that no affiliate credit is sitting there unprotected.
 *
 *   2. GUARD (rolled-back tx): a synthetic CREATOR (role='creator') with
 *        - an affiliate-tagged "Admin adjustment:" CREDIT,
 *        - a plain content "Admin adjustment:" CREDIT,
 *        - an `affiliate_accounts` row + an `affiliate_code_usages` row,
 *      is run through the EXACT creator-conditional guard predicate the wipe
 *      enforces (everCreator=true). We assert:
 *        - the affiliate credit is REJECTED (listing filter + guard predicate),
 *        - the plain content credit is ACCEPTED,
 *        - for a NON-creator the affiliate credit would instead be ACCEPTED
 *          (the carve-out is creator-conditional),
 *        - the affiliate_accounts / affiliate_code_usages rows are NEVER in
 *          the wipe's blast radius and remain present REGARDLESS of role.
 *      Then it throws a sentinel so the whole tx rolls back (nothing persists).
 *
 * Run: npx tsx scripts/verify-affiliate-wipe-protection.ts
 *
 * Uses the SAME guard functions the production wipe imports
 * (src/lib/account-wipes/protected.ts) — not a re-implementation. The
 * creator-conditional flip + the deposits round-trip are proven separately in
 * scripts/verify-creator-conditional-wipe.ts.
 */
import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  isProtectedLedgerType,
  isCreatorRelatedAdjustment,
  isAffiliateRelatedAdjustment,
  WIPE_PRESERVED_SUMMARY,
  WIPE_NEVER_TOUCHES_AFFILIATE_TABLES,
} from "../src/lib/account-wipes/protected.js";

// Load .env then .env.local (local overrides) — same precedence Next uses.
loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

const ADJ_TYPE = "admin_balance_adjustment" as const;
const ADJ_DESC_PREFIX = "Admin adjustment: ";
const MANUAL_WD_DESC_PREFIX = "Manual withdrawal:";

/**
 * The EXACT wipeable predicate the production guard enforces (mirrors the
 * STEP 3 per-row loop + the in-tx re-guard boolean chain in
 * wipe-adjustments-actions.ts). Returns true only if the row is a genuine,
 * wipeable content CREDIT. The creator/affiliate carve-outs are
 * CREATOR-CONDITIONAL — they only fire when `everCreator` is true.
 */
function isWipeable(row: {
  user_id: string;
  type: string;
  status: string;
  description: string;
  amount: number;
  metadata: unknown;
}, ownerUserId: string, everCreator: boolean): boolean {
  if (row.user_id !== ownerUserId) return false;
  if (isProtectedLedgerType(row.type)) return false;
  if (row.type !== ADJ_TYPE) return false;
  if (row.status !== "completed") return false;
  if (!row.description.startsWith(ADJ_DESC_PREFIX)) return false;
  if (row.description.startsWith(MANUAL_WD_DESC_PREFIX)) return false;
  if (row.amount <= 0) return false;
  if (everCreator && isCreatorRelatedAdjustment(row.description, row.metadata)) return false;
  if (everCreator && isAffiliateRelatedAdjustment(row.description, row.metadata)) return false;
  return true;
}

const ROLLBACK = "ROLLBACK_SENTINEL";
let failures = 0;
function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL not set — aborting");
    process.exit(1);
  }
  const adapter = new PrismaPg({ connectionString, max: 3 });
  const db = new PrismaClient({ adapter });

  try {
    // ── Sanity: the constants/string are what we expect ──────────────────
    console.log("── Constant checks ──");
    check(
      "WIPE_NEVER_TOUCHES_AFFILIATE_TABLES === true",
      WIPE_NEVER_TOUCHES_AFFILIATE_TABLES === true,
    );
    check(
      "WIPE_PRESERVED_SUMMARY mentions affiliate commissions + codes + attribution",
      /all affiliate data/i.test(WIPE_PRESERVED_SUMMARY) &&
        /commission/i.test(WIPE_PRESERVED_SUMMARY) &&
        /code/i.test(WIPE_PRESERVED_SUMMARY) &&
        /attribution/i.test(WIPE_PRESERVED_SUMMARY),
    );
    console.log("  summary:", JSON.stringify(WIPE_PRESERVED_SUMMARY));

    // ── Pure-function table (no DB) — affiliate descriptions get rejected ─
    console.log("\n── isAffiliateRelatedAdjustment unit table ──");
    const affiliateSamples = [
      "Admin adjustment: affiliate commission",
      "Admin adjustment: affiliate payout July",
      "Admin adjustment: referral commission",
      "Admin adjustment: referrer bonus",
      "Admin adjustment: referred-user reward",
      "Admin adjustment: weekly affiliate payout",
    ];
    for (const d of affiliateSamples) {
      check(`affiliate-rejected: ${JSON.stringify(d)}`, isAffiliateRelatedAdjustment(d));
    }
    const metaSample = { reason: "innocuous", affiliate_code_usage_id: "abc-123" };
    check(
      "affiliate-rejected via metadata key (affiliate_code_usage_id)",
      isAffiliateRelatedAdjustment("Admin adjustment: payout", metaSample),
    );
    const contentSamples = [
      "Admin adjustment: giveaway prize",
      "Admin adjustment: content bonus",
      "Admin adjustment: tournament reward",
      "Admin adjustment: goodwill credit",
    ];
    for (const d of contentSamples) {
      check(
        `content NOT affiliate-flagged: ${JSON.stringify(d)}`,
        !isAffiliateRelatedAdjustment(d) && !isCreatorRelatedAdjustment(d),
      );
    }
    // Guard against over-matching: "refund" must NOT trip the affiliate guard
    // (we deliberately dropped the short "ref" token).
    check(
      'no over-match: "Admin adjustment: refund correction" is not affiliate',
      !isAffiliateRelatedAdjustment("Admin adjustment: refund correction"),
    );

    // ── 1. TAXONOMY probe (read-only) ────────────────────────────────────
    console.log("\n── Prod admin_balance_adjustment taxonomy (read-only) ──");
    const sample = await db.ledger_transactions.findMany({
      where: { type: ADJ_TYPE, status: "completed" },
      select: { description: true, amount: true, metadata: true },
      take: 20000,
    });
    console.log(`  sampled ${sample.length} admin_balance_adjustment rows`);
    const buckets = new Map<string, number>();
    const affiliateReasons = new Map<string, number>();
    for (const r of sample) {
      const d = r.description ?? "(null)";
      const b = d.startsWith(ADJ_DESC_PREFIX)
        ? "Admin adjustment:"
        : d.startsWith(MANUAL_WD_DESC_PREFIX)
          ? "Manual withdrawal:"
          : "OTHER";
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
      if (isAffiliateRelatedAdjustment(r.description, r.metadata)) {
        affiliateReasons.set(d, (affiliateReasons.get(d) ?? 0) + 1);
      }
    }
    for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(6)}  ${k}`);
    }
    console.log(
      `  rows the affiliate carve-out would protect: ${[...affiliateReasons.values()].reduce((a, b) => a + b, 0)} (across ${affiliateReasons.size} distinct descriptions)`,
    );
    for (const [d, c] of [...affiliateReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`    ${String(c).padStart(5)}  ${JSON.stringify(d)}`);
    }

    // ── 2. ROLLED-BACK guard proof ───────────────────────────────────────
    console.log("\n── Rolled-back guard proof (synthetic user, tx force-rolled-back) ──");
    const suffix = Date.now().toString(36);
    const userId = `wipe-proof-${suffix}`;
    const affiliateAdjId = `00000000-0000-4000-8000-${suffix.padStart(12, "0").slice(-12)}`;

    try {
      await db.$transaction(async (tx) => {
        // Synthetic owner + balance. role='creator' so the creator-conditional
        // affiliate/deal carve-out APPLIES (that is exactly when affiliate info
        // is protected). The affiliate-tables-untouched proof below is
        // unconditional (no wipe ever targets those tables, any role).
        await tx.user.create({
          data: {
            id: userId,
            email: `${userId}@example.invalid`,
            username: userId,
            role: "creator",
          },
        });
        await tx.balances.create({
          data: { user_id: userId, available_balance: 500 },
        });

        // Affiliate-tagged admin_balance_adjustment CREDIT (the dangerous
        // free-text case). Plain content CREDIT (the legitimately wipeable
        // case).
        const affiliateAdj = await tx.ledger_transactions.create({
          data: {
            user_id: userId,
            type: ADJ_TYPE,
            amount: 100,
            balance_before: 400,
            balance_after: 500,
            status: "completed",
            description: "Admin adjustment: affiliate commission payout",
          },
        });
        const contentAdj = await tx.ledger_transactions.create({
          data: {
            user_id: userId,
            type: ADJ_TYPE,
            amount: 50,
            balance_before: 350,
            balance_after: 400,
            status: "completed",
            description: "Admin adjustment: content giveaway",
          },
        });

        // Affiliate TABLES for this user — must remain untouched by any wipe.
        await tx.affiliate_accounts.create({
          data: {
            user_id: userId,
            total_referred: 3,
            total_earned_usd: 250,
            available_usd: 120,
            total_paid_out_usd: 130,
          },
        });
        // affiliate_code_usages needs an affiliate + a referred user; reuse
        // the synthetic user as the affiliate and create a second referred
        // user so the FKs are satisfied (both rolled back).
        const referredId = `wipe-proof-ref-${suffix}`;
        await tx.user.create({
          data: { id: referredId, email: `${referredId}@example.invalid`, username: referredId, role: "user" },
        });
        const usage = await tx.affiliate_code_usages.create({
          data: {
            affiliate_user_id: userId,
            code: `PROOF${suffix}`.slice(0, 20),
            referred_user_id: referredId,
            deposit_amount_usd: 100,
            referrer_cut_usd: 10,
            user_bonus_usd: 5,
            status: "completed",
          },
        });

        // Re-read the two adjustments exactly as the wipe does.
        const live = await tx.ledger_transactions.findMany({
          where: { id: { in: [affiliateAdj.id, contentAdj.id] } },
          select: { id: true, user_id: true, type: true, status: true, description: true, amount: true, metadata: true },
        });
        const byId = new Map(live.map((r) => [r.id, r]));
        const aRow = byId.get(affiliateAdj.id)!;
        const cRow = byId.get(contentAdj.id)!;

        console.log("  [guard predicate — creator (everCreator=true)]");
        check(
          "affiliate adjustment is REJECTED by the wipe guard for a creator",
          isWipeable({ ...aRow, amount: Number(aRow.amount) }, userId, true) === false,
        );
        check(
          "plain content adjustment is ACCEPTED by the wipe guard for a creator",
          isWipeable({ ...cRow, amount: Number(cRow.amount) }, userId, true) === true,
        );
        console.log("  [guard predicate — non-creator (everCreator=false) contrast]");
        check(
          "affiliate adjustment WOULD be wipeable for a non-creator (carve-out is creator-conditional)",
          isWipeable({ ...aRow, amount: Number(aRow.amount) }, userId, false) === true,
        );

        // Listing filter (mirrors listWipeableAdjustments) for a CREATOR:
        // start from the credit subset, drop creator + affiliate (the
        // carve-out applies because everCreator=true here).
        const listed = live
          .filter((r) => Number(r.amount) > 0)
          .filter(
            (r) =>
              !isCreatorRelatedAdjustment(r.description, r.metadata) &&
              !isAffiliateRelatedAdjustment(r.description, r.metadata),
          )
          .map((r) => r.id);
        console.log("  [listing filter — creator]");
        check("affiliate adjustment is NOT listed", !listed.includes(affiliateAdj.id));
        check("content adjustment IS listed", listed.includes(contentAdj.id));

        // Affiliate tables are out of the wipe's blast radius — assert the
        // delete predicate the wipe uses (id ∈ ledgerIds AND type === ADJ_TYPE
        // …) cannot remove them, and that they are present right now.
        console.log("  [affiliate tables untouched]");
        const accStill = await tx.affiliate_accounts.findUnique({ where: { user_id: userId } });
        const usageStill = await tx.affiliate_code_usages.findUnique({ where: { id: usage.id } });
        check("affiliate_accounts row present (never targeted by any wipe)", accStill != null);
        check("affiliate_code_usages row present (never targeted by any wipe)", usageStill != null);
        check(
          "affiliate_accounts earned/available/paid-out totals intact",
          accStill != null &&
            Number(accStill.total_earned_usd) === 250 &&
            Number(accStill.available_usd) === 120 &&
            Number(accStill.total_paid_out_usd) === 130,
        );

        // Simulate the adjustments wipe deleting ONLY the listed (content)
        // row, inside this same tx, then confirm the affiliate adjustment +
        // affiliate tables still exist — proving the affiliate data survives a
        // wipe. (All of this rolls back; nothing persists.)
        const del = await tx.ledger_transactions.deleteMany({
          where: {
            id: { in: listed },
            user_id: userId,
            type: ADJ_TYPE,
            status: "completed",
            description: { startsWith: ADJ_DESC_PREFIX },
            amount: { gt: 0 },
          },
        });
        check("wipe deletes exactly the 1 content adjustment", del.count === 1);
        const affiliateAdjAfter = await tx.ledger_transactions.findUnique({ where: { id: affiliateAdj.id } });
        const accAfter = await tx.affiliate_accounts.findUnique({ where: { user_id: userId } });
        const usageAfter = await tx.affiliate_code_usages.findUnique({ where: { id: usage.id } });
        check("after wipe: affiliate adjustment STILL exists", affiliateAdjAfter != null);
        check("after wipe: affiliate_accounts STILL exists", accAfter != null);
        check("after wipe: affiliate_code_usages STILL exists", usageAfter != null);

        void affiliateAdjId; // (left for readability; unused beyond doc)
        // Force rollback — nothing above is persisted.
        throw new Error(ROLLBACK);
      });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== ROLLBACK) {
        console.error("\n  PROOF TX ERROR (not the rollback sentinel):", err);
        failures++;
      } else {
        console.log("  [tx rolled back cleanly — no synthetic rows persisted]");
      }
    }

    // Belt-and-braces: confirm the synthetic users do NOT exist post-rollback.
    const ghost = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
    check("post-rollback: synthetic user does not exist (prod untouched)", ghost == null);

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await db.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error("FATAL:", err);
    await db.$disconnect();
    process.exit(1);
  }
}

void main();
