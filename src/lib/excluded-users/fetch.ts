import "server-only";

import { cache } from "react";

import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Cached read of the excluded-users blacklist. Returns the bare list
 * of packy.gg user_ids that should be filtered out of dashboard /
 * analytics / PnL / wager aggregates.
 *
 * Cached via React's `cache()` so per-request the admin DB is hit
 * exactly once, regardless of how many call sites consult the list
 * inside a single page render. Failures degrade to an empty list +
 * a console.error — better to show metrics with stale exclusions
 * than to crash every analytics page on an admin DB blip.
 */
export const getExcludedUserIds = cache(async (): Promise<string[]> => {
  try {
    const rows = await adminDb.excluded_users.findMany({
      select: { user_id: true },
    });
    return rows.map((r) => r.user_id);
  } catch (e) {
    console.error(
      "[excluded-users] failed to read blacklist — falling back to empty list:",
      e,
    );
    return [];
  }
});

/**
 * Full row data for the management page (`/system/excluded-users`).
 * Includes the admin who added each entry, so the table can show
 * "added by X on date Y, reason Z".
 *
 * `totalDeposited` is the user's lifetime deposit total
 * (`balances.total_deposited` in the main game DB) — surfaced next to
 * the user ID so an operator can gauge how much volume the exclusion
 * removes from analytics.
 *
 * `balanceV2` is the admin-managed editable annotation from
 * `admin_excluded_user_balance_v2`. Mirrors `totalDeposited` visually
 * but is hand-typed per user (never user-facing). `null` means no row
 * exists yet for that user — rendered as `$0.00` placeholder.
 * `balanceV2TableReady` is `false` if the underlying admin DB table
 * doesn't exist yet (pre-migration) — the UI then shows an inline hint
 * instead of letting the missing-table error crash the page.
 *
 * Not cached — the page wants live data after add / remove server
 * actions revalidate the route.
 */
export type ExcludedUserRow = {
  userId: string;
  reason: string | null;
  excludedByUsername: string;
  createdAt: string;
  totalDeposited: number;
  balanceV2: number | null;
  balanceV2SetAt: string | null;
  balanceV2Notes: string | null;
};

export type ExcludedUsersPageData = {
  rows: ExcludedUserRow[];
  // False if the admin DB table is missing (pre-migration). The UI
  // surfaces an inline hint pointing at the migration the owner needs
  // to run; reads + writes both degrade gracefully until then.
  balanceV2TableReady: boolean;
};

// Postgres "undefined_table" SQLSTATE. Prisma surfaces it via P2010 with
// the meta.code on raw queries, and via P2021 ("table does not exist in
// the current database") on typed model calls. We treat any of these
// signals as "table missing" and degrade to an empty map so the page
// keeps rendering until the owner applies the migration.
function isTableMissing(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; meta?: { code?: unknown } };
  return (
    e.code === "P2021" ||
    e.code === "P2010" ||
    e.meta?.code === "42P01"
  );
}

export async function getExcludedUsersForPage(): Promise<ExcludedUsersPageData> {
  const rows = await adminDb.excluded_users.findMany({
    orderBy: { created_at: "desc" },
    include: {
      admin_user: { select: { username: true } },
    },
  });

  // The blacklist lives in the admin DB, but each user's lifetime
  // deposit total lives on `balances` in the main game DB. No cross-DB
  // joins — pull the balances rows separately in a single batched
  // query and merge by user_id. A user with no balances row (never
  // deposited / no balance ever created) maps to 0.
  const userIds = rows.map((r) => r.user_id);
  const depositByUserId = new Map<string, number>();
  if (userIds.length > 0) {
    const db = await getDb();
    const balanceRows = await db.balances.findMany({
      where: { user_id: { in: userIds } },
      select: { user_id: true, total_deposited: true },
    });
    for (const b of balanceRows) {
      depositByUserId.set(b.user_id, toNumber(b.total_deposited));
    }
  }

  // Balance 2.0 values live in admin_excluded_user_balance_v2 — same
  // admin DB, but a separate table that may not exist yet if the
  // 20260605000000_add_excluded_user_balance_v2 migration hasn't been
  // applied. Catch the "undefined_table" / P2021 case and degrade to
  // an empty map so the page still renders.
  type BalanceV2Entry = { value: number; setAt: string; notes: string | null };
  const balanceV2ByUserId = new Map<string, BalanceV2Entry>();
  let balanceV2TableReady = true;
  if (userIds.length > 0) {
    try {
      const v2Rows = await adminDb.admin_excluded_user_balance_v2.findMany({
        where: { target_user_id: { in: userIds } },
        select: {
          target_user_id: true,
          balance_v2: true,
          set_at: true,
          notes: true,
        },
      });
      for (const v of v2Rows) {
        balanceV2ByUserId.set(v.target_user_id, {
          value: toNumber(v.balance_v2),
          setAt: v.set_at.toISOString(),
          notes: v.notes,
        });
      }
    } catch (err) {
      if (isTableMissing(err)) {
        balanceV2TableReady = false;
      } else {
        console.error(
          "[excluded-users] failed to read admin_excluded_user_balance_v2 — falling back:",
          err,
        );
        balanceV2TableReady = false;
      }
    }
  }

  const mapped: ExcludedUserRow[] = rows.map((r) => {
    const v2 = balanceV2ByUserId.get(r.user_id) ?? null;
    return {
      userId: r.user_id,
      reason: r.reason,
      excludedByUsername: r.admin_user?.username ?? "(unknown)",
      createdAt: r.created_at.toISOString(),
      totalDeposited: depositByUserId.get(r.user_id) ?? 0,
      balanceV2: v2?.value ?? null,
      balanceV2SetAt: v2?.setAt ?? null,
      balanceV2Notes: v2?.notes ?? null,
    };
  });

  return { rows: mapped, balanceV2TableReady };
}
