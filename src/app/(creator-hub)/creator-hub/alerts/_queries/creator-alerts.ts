import {
  queryMainRows,
  queryRows,
} from "@/lib/drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";

import { type CreatorListItem } from "@/lib/backend-api";
import {
  affiliateLeaderboardsApi,
  type LeaderboardAdminRow,
} from "@/lib/backend-api/affiliate-leaderboards";
import { getCachedCreatorRoster } from "@/lib/cache/creator-backend-cache";
import { adminDrizzle } from "@/lib/admin-db";
import { getDealCapInfoByUser } from "../../../../(admin)/creators/_queries/deal-cap-by-user";
import { getAllCreatorsLifetimePnl } from "../../../../(admin)/creators/_queries/all-creators-lifetime-pnl";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

// ─── Types ───────────────────────────────────────────────────────────

export const CREATOR_ALERT_TYPES = [
  "deal_expiring",
  "withdraw_cap_near",
  "leaderboard_ending",
  "risk_flagged",
  "pnl_red",
  "big_ftd",
  "went_live",
] as const;

export type CreatorAlertType = (typeof CREATOR_ALERT_TYPES)[number];

export type CreatorAlertSeverity = "info" | "warning" | "critical";

type PersistedCreatorAlert = {
  id: string;
  target_user_id: string | null;
  alert_type: string;
  dedupe_key: string;
  severity: string;
  metadata: unknown;
  read_at: Date | string | null;
  dismissed_at: Date | string | null;
  created_at: Date | string;
};

export type CreatorAlertMetadata = {
  title: string;
  description: string;
  link?: string;
  valueUsd?: number;
  endsAt?: string;
  [key: string]: unknown;
};

export type DerivedAlertCandidate = {
  dedupeKey: string;
  alertType: CreatorAlertType;
  severity: CreatorAlertSeverity;
  targetUserId: string | null;
  metadata: CreatorAlertMetadata;
};

export type CreatorAlertItem = {
  id: string;
  dedupeKey: string;
  alertType: CreatorAlertType;
  severity: CreatorAlertSeverity;
  targetUserId: string | null;
  targetUsername: string | null;
  metadata: CreatorAlertMetadata;
  readAt: string | null;
  dismissedAt: string | null;
  createdAt: string;
  isUnread: boolean;
};

export type CreatorAlertsResult = {
  alerts: CreatorAlertItem[];
  counts: {
    total: number;
    unread: number;
    critical: number;
    byType: Record<CreatorAlertType, number>;
  };
  syncError: boolean;
};

// ─── Thresholds ──────────────────────────────────────────────────────

const DEAL_EXPIRING_WARNING_DAYS = 7;
const DEAL_EXPIRING_CRITICAL_DAYS = 2;
const LB_ENDING_WARNING_DAYS = 7;
const LB_ENDING_CRITICAL_DAYS = 2;
const CAP_NEAR_WARNING_RATIO = 0.8;
const CAP_NEAR_CRITICAL_RATIO = 0.95;
const PNL_RED_WARNING_USD = 0;
const PNL_RED_CRITICAL_USD = -5_000;
const RISK_FLAGGED_PNL_USD = -2_000;
const RISK_FLAGGED_MIN_DEPOSITS_USD = 10_000;
const BIG_FTD_MIN_USD = 1_000;
const BIG_FTD_LOOKBACK_HOURS = 48;

const SEVERITY_RANK: Record<CreatorAlertSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

// Page size for the leaderboard pagination walk below (the creator roster
// walk now goes through the shared cached roster `getCachedCreatorRoster`).
const PAGE_SIZE = 100;
// Hard upper bound on the leaderboard pagination walk so a wrong `total`
// can't spin an unbounded loop. 50 pages × 100 = 5,000 leaderboards, far
// above the live pool. The backend rejects `limit > 200` with HTTP 422,
// so we page in PAGE_SIZE (100) chunks — same shape as creators-stats.ts.
const MAX_PAGES = 50;

// ─── Schema self-heal (idempotent) ───────────────────────────────────

// ─── Roster walk (shared cached roster) ──────────────────────────────

/**
 * Walk the full creator roster — delegates to the shared cached roster
 * (`getCachedCreatorRoster`), the same paged `creatorsApi.list` walk up to the
 * 500 cap now shared across the creator-hub fan-outs and Upstash-cached when
 * configured (a pure pass-through to the live walk when dormant). The roster
 * content/order is the ordered concatenation of the same offset pages, so the
 * downstream alert derivation is unchanged. Backend errors still propagate to
 * the caller's existing try/catch (which logs + returns no candidates).
 */
async function walkAllCreators(): Promise<CreatorListItem[]> {
  return getCachedCreatorRoster();
}

function daysUntil(iso: string, nowMs: number): number {
  return (new Date(iso).getTime() - nowMs) / (24 * 60 * 60 * 1000);
}

function dealExpiringSeverity(daysLeft: number): CreatorAlertSeverity | null {
  if (daysLeft < 0) return null;
  if (daysLeft <= DEAL_EXPIRING_CRITICAL_DAYS) return "critical";
  if (daysLeft <= DEAL_EXPIRING_WARNING_DAYS) return "warning";
  return null;
}

function lbEndingSeverity(daysLeft: number): CreatorAlertSeverity | null {
  if (daysLeft < 0) return null;
  if (daysLeft <= LB_ENDING_CRITICAL_DAYS) return "critical";
  if (daysLeft <= LB_ENDING_WARNING_DAYS) return "warning";
  return null;
}

function capNearSeverity(used: number, total: number | null): CreatorAlertSeverity | null {
  if (total == null || total <= 0) return null;
  const ratio = used / total;
  if (ratio >= CAP_NEAR_CRITICAL_RATIO) return "critical";
  if (ratio >= CAP_NEAR_WARNING_RATIO) return "warning";
  return null;
}

// ─── Derivation ──────────────────────────────────────────────────────

async function deriveBigFtdAlerts(): Promise<DerivedAlertCandidate[]> {
  const alerts: DerivedAlertCandidate[] = [];
  try {
    const excluded = await getExcludedUserIds();
    // Anchor BOTH engines to one instant for deterministic parity.
    const since = new Date(Date.now() - BIG_FTD_LOOKBACK_HOURS * 3_600_000);
    const rows = await queryMainRows<
      {
        ledger_tx_id: string;
        user_id: string;
        amount: string;
        created_at: Date | string;
        creator_user_id: string | null;
      }[]
    >(
      `
      WITH first_deposits AS (
        SELECT DISTINCT ON (lt.user_id)
          lt.id AS ledger_tx_id,
          lt.user_id,
          lt.amount::numeric AS amount,
          lt.created_at
        FROM ledger_transactions lt
        JOIN "user" u ON u.id = lt.user_id
        WHERE lt.type::text = 'deposit'
          AND lt.status = 'completed'
          AND u.role NOT IN ('admin', 'support', 'creator')
          AND NOT (u.id = ANY($3::text[]))
        ORDER BY lt.user_id, lt.created_at ASC
      )
      SELECT
        fd.ledger_tx_id,
        fd.user_id,
        fd.amount::text,
        fd.created_at,
        (
          SELECT acu_c.affiliate_user_id
            FROM affiliate_code_usages acu_c
           WHERE acu_c.referred_user_id = fd.user_id
             AND acu_c.created_at <= fd.created_at
             AND acu_c.created_at >= fd.created_at - INTERVAL '7 days'
           ORDER BY acu_c.created_at DESC
           LIMIT 1
        ) AS creator_user_id
      FROM first_deposits fd
      WHERE fd.created_at >= $1
        AND fd.amount >= $2
      `,
      since,
      BIG_FTD_MIN_USD,
      excluded,
    );

    for (const row of rows) {
      if (!row.creator_user_id) continue;
      const amount = Number(row.amount);
      alerts.push({
        dedupeKey: `big_ftd:${row.ledger_tx_id}`,
        alertType: "big_ftd",
        severity: amount >= 5_000 ? "critical" : "warning",
        targetUserId: row.creator_user_id,
        metadata: {
          title: "Big first-time deposit",
          description: `New depositor FTD of $${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })} under this creator's code.`,
          link: `/creator-hub/creators/${row.creator_user_id}`,
          valueUsd: amount,
        },
      });
    }
  } catch (err) {
    console.error("[creator-alerts] big_ftd derivation failed:", err);
  }
  return alerts;
}

const deriveAlertCandidates = unstable_cache(
  async (): Promise<DerivedAlertCandidate[]> => {
    const nowMs = Date.now();
    const candidates: DerivedAlertCandidate[] = [];

    let roster: CreatorListItem[] = [];
    try {
      roster = await walkAllCreators();
    } catch (err) {
      console.error("[creator-alerts] roster walk failed:", err);
      return candidates;
    }

    const usernameById = new Map(
      roster.map((c) => [c.id, c.username ?? c.id.slice(0, 8)]),
    );

    // Deal expiring + went live
    const activeDeals: { userId: string; dealId: string }[] = [];
    for (const c of roster) {
      if (c.active_session_id) {
        candidates.push({
          dedupeKey: `went_live:${c.id}:${c.active_session_id}`,
          alertType: "went_live",
          severity: "info",
          targetUserId: c.id,
          metadata: {
            title: "Creator went live",
            description: `${usernameById.get(c.id)} is streaming right now.`,
            link: `/creator-hub/creators/${c.id}`,
          },
        });
      }

      const deal = c.current_deal;
      if (
        !deal ||
        (deal.status !== "active" && deal.status !== "scheduled")
      ) {
        continue;
      }

      activeDeals.push({ userId: c.id, dealId: deal.id });

      const severity = dealExpiringSeverity(daysUntil(deal.week_end_utc, nowMs));
      if (severity) {
        const daysLeft = Math.ceil(daysUntil(deal.week_end_utc, nowMs));
        candidates.push({
          dedupeKey: `deal_expiring:${deal.id}`,
          alertType: "deal_expiring",
          severity,
          targetUserId: c.id,
          metadata: {
            title: "Deal expiring soon",
            description: `${usernameById.get(c.id)}'s deal ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
            link: `/creator-hub/creators/${c.id}`,
            endsAt: deal.week_end_utc,
          },
        });
      }
    }

    // Withdraw cap nearly hit
    const capByUser = await getDealCapInfoByUser(activeDeals).catch((err: unknown) => {
      console.error("[creator-alerts] cap lookup failed:", err);
      return new Map();
    });
    for (const { userId, dealId } of activeDeals) {
      const cap = capByUser.get(userId);
      if (!cap) continue;
      const severity = capNearSeverity(cap.usedUsd, cap.totalCapUsd);
      if (!severity) continue;
      const pct =
        cap.totalCapUsd != null && cap.totalCapUsd > 0
          ? Math.round((cap.usedUsd / cap.totalCapUsd) * 100)
          : 0;
      candidates.push({
        dedupeKey: `withdraw_cap_near:${dealId}`,
        alertType: "withdraw_cap_near",
        severity,
        targetUserId: userId,
        metadata: {
          title: "Withdraw cap nearly hit",
          description: `${usernameById.get(userId)} has used ${pct}% of the deal withdraw cap ($${cap.usedUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}${cap.totalCapUsd != null ? ` / $${cap.totalCapUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : ""}).`,
          link: `/creator-hub/creators/${userId}`,
          valueUsd: cap.usedUsd,
        },
      });
    }

    // Leaderboards ending. The backend caps `limit` at 200 (HTTP 422
    // otherwise), so page through in PAGE_SIZE (100) chunks — same walk
    // shape as creators-stats.ts: increment offset by the page size, stop
    // when a page comes back short/empty or when MAX_PAGES is hit.
    try {
      const leaderboards: LeaderboardAdminRow[] = [];
      for (let p = 0; p < MAX_PAGES; p++) {
        const lbPage = await affiliateLeaderboardsApi.list({
          status: "approved",
          offset: p * PAGE_SIZE,
          limit: PAGE_SIZE,
        });
        leaderboards.push(...lbPage.leaderboards);
        if (lbPage.leaderboards.length < PAGE_SIZE) break;
      }
      for (const lb of leaderboards) {
        if (lb.cancelled_at || lb.time_status === "ended") continue;
        const severity = lbEndingSeverity(daysUntil(lb.end_date, nowMs));
        if (!severity) continue;
        const daysLeft = Math.ceil(daysUntil(lb.end_date, nowMs));
        candidates.push({
          dedupeKey: `leaderboard_ending:${lb.id}`,
          alertType: "leaderboard_ending",
          severity,
          targetUserId: lb.creator_user_id,
          metadata: {
            title: "Leaderboard ending soon",
            description: `"${lb.title}" ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`,
            link: `/creator-hub/creators/${lb.creator_user_id}`,
            endsAt: lb.end_date,
          },
        });
      }
    } catch (err) {
      console.error("[creator-alerts] leaderboard walk failed:", err);
    }

    // Lifetime PnL red + risk flagged
    try {
      const pnl = await getAllCreatorsLifetimePnl();
      for (const row of pnl.byCreator) {
        if (row.pnl < PNL_RED_WARNING_USD) {
          candidates.push({
            dedupeKey: `pnl_red:${row.userId}`,
            alertType: "pnl_red",
            severity:
              row.pnl <= PNL_RED_CRITICAL_USD ? "critical" : "warning",
            targetUserId: row.userId,
            metadata: {
              title: "Creator P&L in the red",
              description: `${row.username ?? row.userId.slice(0, 8)} lifetime house P&L is ${row.pnl < 0 ? "−" : ""}$${Math.abs(row.pnl).toLocaleString("en-US", { maximumFractionDigits: 0 })}.`,
              link: `/creator-hub/creators/${row.userId}`,
              valueUsd: row.pnl,
            },
          });
        }

        if (
          row.pnl <= RISK_FLAGGED_PNL_USD &&
          row.totalDeposits >= RISK_FLAGGED_MIN_DEPOSITS_USD
        ) {
          candidates.push({
            dedupeKey: `risk_flagged:${row.userId}`,
            alertType: "risk_flagged",
            severity: "critical",
            targetUserId: row.userId,
            metadata: {
              title: "Risk flag — material house loss",
              description: `${row.username ?? row.userId.slice(0, 8)} has $${row.totalDeposits.toLocaleString("en-US", { maximumFractionDigits: 0 })} attributed deposits with a ${row.pnl < 0 ? "−" : ""}$${Math.abs(row.pnl).toLocaleString("en-US", { maximumFractionDigits: 0 })} lifetime P&L — review the Risk tab.`,
              link: `/creator-hub/creators/${row.userId}?tab=risk`,
            },
          });
        }
      }
    } catch (err) {
      console.error("[creator-alerts] lifetime PnL derivation failed:", err);
    }

    const bigFtds = await deriveBigFtdAlerts();
    candidates.push(...bigFtds);

    return candidates;
  },
  ["creator-hub:alert-candidates:v1"],
  { revalidate: 60, tags: ["creator-hub-alerts"] },
);

// ─── Sync + list ─────────────────────────────────────────────────────

// Fingerprint of the last candidate set successfully synced into the ADMIN
// DB. `deriveAlertCandidates` is `unstable_cache`d (60s), so within a cache
// window EVERY render produces the IDENTICAL candidate set — yet the old code
// re-ran the full upsert-all + stale-sweep ADMIN-DB writes on every GET (the
// alerts dock renders on each hub view). Memoizing on the candidate
// fingerprint lets us skip the redundant writes when the persisted state is
// already current, while keeping the sync fully idempotent: a CHANGED
// candidate set (different keys / severity / metadata) produces a new
// fingerprint and re-syncs, the first call after boot always syncs (null
// start), and an error never records the fingerprint so it retries. This only
// gates the WRITE half — `getCreatorAlerts` still reads the live read/dismiss
// state from `creator_alerts` on every call.
let lastSyncedFingerprint: string | null = null;

function candidateFingerprint(candidates: DerivedAlertCandidate[]): string {
  return JSON.stringify(
    candidates
      .map((c) => ({
        k: c.dedupeKey,
        s: c.severity,
        t: c.targetUserId,
        m: c.metadata,
      }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0)),
  );
}

async function syncCandidates(
  candidates: DerivedAlertCandidate[],
): Promise<boolean> {
  // Skip the redundant ADMIN-DB write pass when the candidate set is byte-for-
  // byte the one we last persisted (the common case inside the 60s derive
  // cache). The list read in `getCreatorAlerts` is unaffected.
  const fingerprint = candidateFingerprint(candidates);
  if (fingerprint === lastSyncedFingerprint) return false;

  try {
    const activeKeys = candidates.map((c) => c.dedupeKey);
    const payload = candidates.map((c) => ({
      target_user_id: c.targetUserId,
      alert_type: c.alertType,
      dedupe_key: c.dedupeKey,
      severity: c.severity,
      metadata: c.metadata,
    }));

    await adminDrizzle.transaction(async (tx) => {
      if (payload.length > 0) {
        await queryRows<Record<string, never>[]>(
          tx,
          `
            INSERT INTO creator_alerts (
              target_user_id,
              alert_type,
              dedupe_key,
              severity,
              metadata
            )
            SELECT
              target_user_id,
              alert_type,
              dedupe_key,
              severity,
              metadata
              FROM jsonb_to_recordset($1::jsonb) AS candidate(
                target_user_id text,
                alert_type text,
                dedupe_key text,
                severity text,
                metadata jsonb
              )
            ON CONFLICT (dedupe_key) DO UPDATE
              SET target_user_id = EXCLUDED.target_user_id,
                  alert_type = EXCLUDED.alert_type,
                  severity = EXCLUDED.severity,
                  metadata = EXCLUDED.metadata
          `,
          JSON.stringify(payload),
        );
      }

      // Auto-dismiss stale alerts whose condition cleared (not user-dismissed).
      await queryRows<Record<string, never>[]>(
        tx,
        `
          UPDATE creator_alerts
             SET dismissed_at = now()
           WHERE dismissed_at IS NULL
             AND NOT (dedupe_key = ANY($1::text[]))
        `,
        activeKeys,
      );
    });
    // Record only on a fully-successful pass so any failure path retries the
    // write next render instead of being skipped by the fingerprint gate.
    lastSyncedFingerprint = fingerprint;
    return false;
  } catch (err) {
    console.error("[creator-alerts] sync failed:", err);
    return true;
  }
}

function parseMetadata(raw: unknown): CreatorAlertMetadata {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const m = raw as Record<string, unknown>;
    return {
      title: typeof m.title === "string" ? m.title : "Alert",
      description:
        typeof m.description === "string" ? m.description : "",
      link: typeof m.link === "string" ? m.link : undefined,
      valueUsd: typeof m.valueUsd === "number" ? m.valueUsd : undefined,
      endsAt: typeof m.endsAt === "string" ? m.endsAt : undefined,
    };
  }
  return { title: "Alert", description: "" };
}

function isAlertType(v: string): v is CreatorAlertType {
  return (CREATOR_ALERT_TYPES as readonly string[]).includes(v);
}

function isSeverity(v: string): v is CreatorAlertSeverity {
  return v === "info" || v === "warning" || v === "critical";
}

async function hydrateUsernames(
  userIds: string[],
): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>();
  if (userIds.length === 0) return map;
  try {
    const users = await queryMainRows<
      { id: string; username: string | null }[]
    >(
      `
        SELECT id, username
          FROM "user"
         WHERE id = ANY($1::text[])
      `,
      userIds,
    );
    for (const u of users) map.set(u.id, u.username ?? null);
  } catch (err) {
    console.error("[creator-alerts] username hydration failed:", err);
  }
  return map;
}

/**
 * Sync derived alerts into the ADMIN DB and return the active (non-dismissed)
 * list merged with read/dismiss state. Content is derived from live data;
 * `creator_alerts` persists manager read/dismiss state only.
 */
export async function getCreatorAlerts(): Promise<CreatorAlertsResult> {
  const candidates = await deriveAlertCandidates();
  const syncError = await syncCandidates(candidates);
  const activeKeys = new Set(candidates.map((c) => c.dedupeKey));

  let rows: PersistedCreatorAlert[] = [];
  try {
    rows = await queryRows<PersistedCreatorAlert[]>(
      adminDrizzle,
      `
        SELECT
          id::text,
          target_user_id,
          alert_type,
          dedupe_key,
          severity,
          metadata,
          read_at,
          dismissed_at,
          created_at
          FROM creator_alerts
         WHERE dismissed_at IS NULL
           AND dedupe_key = ANY($1::text[])
         ORDER BY severity ASC, created_at DESC
      `,
      [...activeKeys],
    );
  } catch (err) {
    console.error("[creator-alerts] list read failed:", err);
  }

  const candidateByKey = new Map(
    candidates.map((c) => [c.dedupeKey, c]),
  );
  const targetIds = [
    ...new Set(
      rows
        .map((r) => r.target_user_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const usernames = await hydrateUsernames(targetIds);

  const alerts: CreatorAlertItem[] = rows
    .map((row) => {
      const derived = candidateByKey.get(row.dedupe_key);
      const alertType = isAlertType(row.alert_type)
        ? row.alert_type
        : (derived?.alertType ?? "deal_expiring");
      const severity = isSeverity(row.severity)
        ? row.severity
        : (derived?.severity ?? "info");
      return {
        id: row.id,
        dedupeKey: row.dedupe_key,
        alertType,
        severity,
        targetUserId: row.target_user_id,
        targetUsername: row.target_user_id
          ? (usernames.get(row.target_user_id) ?? null)
          : null,
        metadata: derived?.metadata ?? parseMetadata(row.metadata),
        readAt: row.read_at ? new Date(row.read_at).toISOString() : null,
        dismissedAt: row.dismissed_at
          ? new Date(row.dismissed_at).toISOString()
          : null,
        createdAt: new Date(row.created_at).toISOString(),
        isUnread: row.read_at == null,
      };
    })
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

  const byType = Object.fromEntries(
    CREATOR_ALERT_TYPES.map((t) => [t, 0]),
  ) as Record<CreatorAlertType, number>;
  for (const a of alerts) byType[a.alertType] += 1;

  return {
    alerts,
    counts: {
      total: alerts.length,
      unread: alerts.filter((a) => a.isUnread).length,
      critical: alerts.filter((a) => a.severity === "critical").length,
      byType,
    },
    syncError,
  };
}
