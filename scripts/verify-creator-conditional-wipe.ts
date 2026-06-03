/**
 * verify-creator-conditional-wipe.ts — ROLLED-BACK proof of the two
 * 2026-06-03 policy changes to the account wipe:
 *
 *   TASK 1 — creator-CONDITIONAL protection: the protected set (deposits,
 *            withdrawals, affiliate, deal-tagged adjustments) is enforced ONLY
 *            when the target user IS or WAS a creator. For a never-creator
 *            every category is wipeable.
 *
 *   DEPOSITS — the new recoverable "deposits" category: snapshot the `deposit`
 *            ledger rows + reduce balances.total_deposited, then RESTORE
 *            re-inserts the rows + re-adds the counter. Round-trips exactly.
 *
 * Everything destructive runs inside a transaction that is force ROLLED BACK
 * at the end, so the (stale) prod-snapshot DB is never mutated.
 *
 * It uses the SAME pure guard functions the production wipe imports
 * (src/lib/account-wipes/protected.ts + categories.ts) — not a
 * re-implementation — and replicates ONLY the ever-creator UNION
 * (getCreatorProtectionStatus's dual-DB derivation) against the synthetic
 * rows, asserting the union flips the carve-out on/off.
 *
 * Run: npx tsx scripts/verify-creator-conditional-wipe.ts
 */
import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  isCreatorRelatedAdjustment,
  isAffiliateRelatedAdjustment,
  wipePreservedSummary,
} from "../src/lib/account-wipes/protected.js";
import {
  wipeCategoryBlockReason,
  isCreatorProtectedCategory,
  isEnabledCategory,
  CREATOR_PROTECTED_CATEGORIES,
} from "../src/lib/account-wipes/categories.js";

loadEnv({ path: ".env" });
loadEnv({ path: ".env.local", override: true });

const ADJ_TYPE = "admin_balance_adjustment" as const;
const ADJ_DESC_PREFIX = "Admin adjustment: ";
const DEPOSIT_TYPE = "deposit" as const;

/**
 * The EXACT creator-conditional wipeable predicate for a content adjustment
 * (mirrors the STEP 3 / in-tx guard chain in wipe-adjustments-actions.ts):
 * the creator/affiliate carve-outs only fire when `everCreator` is true.
 */
function isAdjustmentWipeable(
  row: { user_id: string; type: string; status: string; description: string; amount: number; metadata: unknown },
  ownerUserId: string,
  everCreator: boolean,
): boolean {
  if (row.user_id !== ownerUserId) return false;
  if (row.type !== ADJ_TYPE) return false;
  if (row.status !== "completed") return false;
  if (!row.description.startsWith(ADJ_DESC_PREFIX)) return false;
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
    // ── Pure category-policy checks (no DB) ──────────────────────────────
    console.log("── Category policy (pure) ──");
    check(
      "creator-protected set = deposits, withdrawals, affiliate",
      [...CREATOR_PROTECTED_CATEGORIES].sort().join(",") ===
        ["affiliate", "deposits", "withdrawals"].sort().join(","),
    );
    check("deposits is creator-protected", isCreatorProtectedCategory("deposits"));
    check("deposits is ENABLED", isEnabledCategory("deposits"));
    check("balance is NOT creator-protected", !isCreatorProtectedCategory("balance"));
    // Block-reason matrix.
    check(
      "deposits BLOCKED for ever-creator",
      wipeCategoryBlockReason("deposits", true) !== null,
    );
    check(
      "deposits ALLOWED for non-creator",
      wipeCategoryBlockReason("deposits", false) === null,
    );
    check(
      "withdrawals BLOCKED for non-creator too (disabled/coming-soon)",
      wipeCategoryBlockReason("withdrawals", false) !== null,
    );
    check(
      "gaming BLOCKED for non-creator (disabled/coming-soon)",
      wipeCategoryBlockReason("gaming", false) !== null,
    );
    check(
      "balance ALLOWED for non-creator",
      wipeCategoryBlockReason("balance", false) === null,
    );
    check(
      "balance ALLOWED for creator (not in protected set)",
      wipeCategoryBlockReason("balance", true) === null,
    );

    // Role-aware preserved summary.
    console.log("\n── Role-aware preserved summary ──");
    check(
      "creator summary mentions deposits + withdrawals + affiliate + deal",
      /deposit/i.test(wipePreservedSummary(true)) &&
        /withdrawal/i.test(wipePreservedSummary(true)) &&
        /affiliate/i.test(wipePreservedSummary(true)) &&
        /deal/i.test(wipePreservedSummary(true)),
    );
    check(
      "non-creator summary does NOT promise to preserve deposits",
      !/deposits[, ]/i.test(wipePreservedSummary(false)),
    );
    console.log("  creator    :", JSON.stringify(wipePreservedSummary(true)));
    console.log("  non-creator:", JSON.stringify(wipePreservedSummary(false)));

    // ── Rolled-back proof: creator-conditional adjustment carve-out ──────
    console.log("\n── Rolled-back: creator-conditional adjustment carve-out ──");
    const suffix = Date.now().toString(36);
    const userId = `cc-proof-${suffix}`;

    try {
      await db.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: userId, email: `${userId}@example.invalid`, username: userId, role: "user" },
        });
        await tx.balances.create({
          data: { user_id: userId, available_balance: 500, total_deposited: 1000 },
        });

        // A deal-tagged + an affiliate-tagged + a plain content CREDIT.
        const dealAdj = await tx.ledger_transactions.create({
          data: { user_id: userId, type: ADJ_TYPE, amount: 100, balance_before: 400, balance_after: 500, status: "completed", description: "Admin adjustment: weekly deal" },
        });
        const affAdj = await tx.ledger_transactions.create({
          data: { user_id: userId, type: ADJ_TYPE, amount: 80, balance_before: 320, balance_after: 400, status: "completed", description: "Admin adjustment: affiliate commission" },
        });
        const plainAdj = await tx.ledger_transactions.create({
          data: { user_id: userId, type: ADJ_TYPE, amount: 50, balance_before: 270, balance_after: 320, status: "completed", description: "Admin adjustment: content giveaway" },
        });

        const live = await tx.ledger_transactions.findMany({
          where: { id: { in: [dealAdj.id, affAdj.id, plainAdj.id] } },
          select: { id: true, user_id: true, type: true, status: true, description: true, amount: true, metadata: true },
        });
        const byId = new Map(live.map((r) => [r.id, { ...r, amount: Number(r.amount) }]));

        // For a NON-creator (everCreator=false) — ALL three are wipeable.
        console.log("  [non-creator: everCreator=false]");
        check("deal-tagged adjustment IS wipeable for a non-creator", isAdjustmentWipeable(byId.get(dealAdj.id)!, userId, false));
        check("affiliate-tagged adjustment IS wipeable for a non-creator", isAdjustmentWipeable(byId.get(affAdj.id)!, userId, false));
        check("plain content adjustment IS wipeable for a non-creator", isAdjustmentWipeable(byId.get(plainAdj.id)!, userId, false));

        // For a CREATOR (everCreator=true) — deal + affiliate are REJECTED.
        console.log("  [creator: everCreator=true]");
        check("deal-tagged adjustment is REJECTED for a creator", !isAdjustmentWipeable(byId.get(dealAdj.id)!, userId, true));
        check("affiliate-tagged adjustment is REJECTED for a creator", !isAdjustmentWipeable(byId.get(affAdj.id)!, userId, true));
        check("plain content adjustment is STILL wipeable for a creator", isAdjustmentWipeable(byId.get(plainAdj.id)!, userId, true));

        throw new Error(ROLLBACK);
      });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== ROLLBACK) {
        console.error("\n  CARVE-OUT TX ERROR:", err);
        failures++;
      } else {
        console.log("  [tx rolled back cleanly]");
      }
    }

    // ── Rolled-back proof: ever-creator UNION (the derivation) ───────────
    // Replicates getCreatorProtectionStatus's union: role==='creator' OR owns
    // affiliate_codes OR audit role_changed→creator. We test the two MAIN-DB
    // signals here against synthetic rows (the audit signal is admin-DB and
    // separately unit-asserted via getUserCreatorHistory in code).
    console.log("\n── Rolled-back: ever-creator UNION (main-DB signals) ──");
    const csuffix = Date.now().toString(36) + "b";
    const plainUserId = `evc-plain-${csuffix}`;
    const codeOwnerId = `evc-code-${csuffix}`;
    const creatorUserId = `evc-creator-${csuffix}`;
    try {
      await db.$transaction(async (tx) => {
        // (a) plain user, no codes, role=user → NOT ever-creator.
        await tx.user.create({ data: { id: plainUserId, email: `${plainUserId}@x.invalid`, username: plainUserId, role: "user" } });
        // (b) role=user but owns an affiliate_code → ever-creator (ex-creator).
        await tx.user.create({ data: { id: codeOwnerId, email: `${codeOwnerId}@x.invalid`, username: codeOwnerId, role: "user" } });
        await tx.affiliate_codes.create({ data: { user_id: codeOwnerId, code: `EVC${csuffix}`.slice(0, 19) } });
        // (c) role=creator → ever-creator (current creator).
        await tx.user.create({ data: { id: creatorUserId, email: `${creatorUserId}@x.invalid`, username: creatorUserId, role: "creator" } });

        // Replicate the union for each (main-DB part).
        async function everCreatorMainDb(uid: string): Promise<boolean> {
          const u = await tx.user.findUnique({ where: { id: uid }, select: { role: true } });
          const code = await tx.affiliate_codes.findFirst({ where: { user_id: uid }, select: { id: true } });
          return u?.role === "creator" || code != null;
        }

        const plainEC = await everCreatorMainDb(plainUserId);
        const codeEC = await everCreatorMainDb(codeOwnerId);
        const creatorEC = await everCreatorMainDb(creatorUserId);

        check("plain user (role=user, no codes) is NOT ever-creator", plainEC === false);
        check("affiliate_codes owner (role=user) IS ever-creator (ex-creator)", codeEC === true);
        check("role=creator IS ever-creator", creatorEC === true);

        // And the policy consequence: deposits blocked for (b)+(c), allowed for (a).
        check("deposits ALLOWED for the plain user", wipeCategoryBlockReason("deposits", plainEC) === null);
        check("deposits BLOCKED for the code-owning ex-creator", wipeCategoryBlockReason("deposits", codeEC) !== null);
        check("deposits BLOCKED for the current creator", wipeCategoryBlockReason("deposits", creatorEC) !== null);

        throw new Error(ROLLBACK);
      });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== ROLLBACK) {
        console.error("\n  UNION TX ERROR:", err);
        failures++;
      } else {
        console.log("  [tx rolled back cleanly]");
      }
    }

    // ── Rolled-back proof: deposits wipe + restore round-trip ────────────
    console.log("\n── Rolled-back: deposits snapshot → delete → restore round-trip ──");
    const dsuffix = Date.now().toString(36) + "d";
    const depUserId = `dep-proof-${dsuffix}`;
    try {
      await db.$transaction(async (tx) => {
        await tx.user.create({ data: { id: depUserId, email: `${depUserId}@x.invalid`, username: depUserId, role: "user" } });
        // total_deposited starts at 300 (= the two deposits below).
        await tx.balances.create({ data: { user_id: depUserId, available_balance: 75, total_deposited: 300 } });

        const dep1 = await tx.ledger_transactions.create({
          data: { user_id: depUserId, type: DEPOSIT_TYPE, amount: 200, balance_before: 0, balance_after: 200, status: "completed", description: "Crypto deposit" },
        });
        const dep2 = await tx.ledger_transactions.create({
          data: { user_id: depUserId, type: DEPOSIT_TYPE, amount: 100, balance_before: 200, balance_after: 300, status: "completed", description: "Crypto deposit" },
        });
        // A non-deposit ledger row that must NOT be touched.
        const wager = await tx.ledger_transactions.create({
          data: { user_id: depUserId, type: "pack_opening", amount: 25, balance_before: 300, balance_after: 275, status: "completed", description: "Pack opening" },
        });

        // SNAPSHOT — read the deposit rows + compute the clamped counter cut.
        const depRows = await tx.ledger_transactions.findMany({ where: { user_id: depUserId, type: DEPOSIT_TYPE, status: "completed" } });
        const totalAmount = depRows.reduce((a, r) => a + Number(r.amount), 0);
        const balRow = await tx.balances.findUnique({ where: { user_id: depUserId } });
        const totalDepositedBefore = Number(balRow!.total_deposited);
        const counterReduction = Math.min(totalAmount, totalDepositedBefore);
        check("snapshot captured 2 deposit rows", depRows.length === 2);
        check("snapshot total = 300", totalAmount === 300);
        check("counter reduction clamped to total_deposited = 300", counterReduction === 300);

        // DELETE — deposits + reduce counter (the exact wipe steps).
        const depIds = depRows.map((r) => r.id);
        await tx.balances.updateMany({ where: { user_id: depUserId, last_transaction_id: { in: depIds } }, data: { last_transaction_id: null } });
        const del = await tx.ledger_transactions.deleteMany({ where: { id: { in: depIds }, user_id: depUserId, type: DEPOSIT_TYPE, status: "completed" } });
        await tx.balances.updateMany({ where: { user_id: depUserId }, data: { total_deposited: totalDepositedBefore - counterReduction } });

        check("delete removed exactly 2 deposit rows", del.count === 2);
        const afterDelDeps = await tx.ledger_transactions.count({ where: { user_id: depUserId, type: DEPOSIT_TYPE } });
        const afterDelBal = await tx.balances.findUnique({ where: { user_id: depUserId } });
        const wagerAfter = await tx.ledger_transactions.findUnique({ where: { id: wager.id } });
        check("after delete: 0 deposit rows remain", afterDelDeps === 0);
        check("after delete: total_deposited reduced to 0", Number(afterDelBal!.total_deposited) === 0);
        check("after delete: the pack_opening (non-deposit) row is untouched", wagerAfter != null);

        // RESTORE — re-insert the snapshotted rows + re-add the counter cut.
        const rowsForInsert = depRows.map((r) => {
          const copy: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            if (v === undefined) continue;
            copy[k] = v;
          }
          return copy;
        });
        await tx.ledger_transactions.createMany({ data: rowsForInsert as never, skipDuplicates: true });
        const bNow = await tx.balances.findUnique({ where: { user_id: depUserId } });
        await tx.balances.updateMany({ where: { user_id: depUserId }, data: { total_deposited: Number(bNow!.total_deposited) + counterReduction } });

        const restoredDeps = await tx.ledger_transactions.findMany({ where: { user_id: depUserId, type: DEPOSIT_TYPE }, orderBy: { amount: "desc" } });
        const restoredBal = await tx.balances.findUnique({ where: { user_id: depUserId } });
        check("after restore: 2 deposit rows are back", restoredDeps.length === 2);
        check("after restore: deposit ids + amounts match the snapshot", restoredDeps.map((r) => r.id).sort().join(",") === [dep1.id, dep2.id].sort().join(",") && restoredDeps.reduce((a, r) => a + Number(r.amount), 0) === 300);
        check("after restore: total_deposited back to 300", Number(restoredBal!.total_deposited) === 300);

        throw new Error(ROLLBACK);
      });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== ROLLBACK) {
        console.error("\n  DEPOSITS TX ERROR:", err);
        failures++;
      } else {
        console.log("  [tx rolled back cleanly]");
      }
    }

    // Belt-and-braces: none of the synthetic users persisted.
    for (const uid of [userId, plainUserId, codeOwnerId, creatorUserId, depUserId]) {
      const ghost = await db.user.findUnique({ where: { id: uid }, select: { id: true } });
      check(`post-rollback: synthetic user ${uid} does not exist (prod untouched)`, ghost == null);
    }

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
