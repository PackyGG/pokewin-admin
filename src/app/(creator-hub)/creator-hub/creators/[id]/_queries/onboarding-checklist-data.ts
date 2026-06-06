import "server-only";

import { adminDb } from "@/lib/admin-db";
import { safeQuery } from "@/lib/errors/safe-query";
import { logWarn } from "@/lib/errors/logger";
import { affiliateLeaderboardsApi } from "@/lib/backend-api/affiliate-leaderboards";
import { creatorsApi } from "@/lib/backend-api";
import { isLinkedSocialUsername } from "../../../../../(admin)/creators/_queries/socials-by-user";
import { getCreatorSocialUrls } from "@/lib/creator-social-urls";
import { getCreatorHeader } from "@/lib/queries/creators-detail";

import {
  EMPTY_MANUAL_STATE,
  MIN_SOCIALS,
  type ChecklistItem,
  type ChecklistManualState,
  type CreatorChecklistData,
} from "../_components/onboarding-checklist-shared";

/**
 * Per-creator Onboarding Checklist — server data layer.
 *
 * Owner spec (plan §"Per-creator Onboarding Checklist"):
 *   AUTO items (derived live, never a stored checkbox):
 *     1. ≥ 2 socials set        → distinct linked platforms in creator_socials.
 *     2. First deal set up      → a creator deal exists (backend).
 *     3. Leaderboard set up     → an affiliate leaderboard exists (backend).
 *     4. API key set up         → creator has an API key (backend status).
 *     5. Creator has a PFP      → the packy.gg user has an avatar image.
 *   MANUAL items (manager-controlled, persisted in the ADMIN-DB
 *   `creator_onboarding_checklist` row):
 *     6. Twitter giveaway hosted  → toggle + URL.
 *     7. Streaming assets provided → toggle.
 *     - Leaderboard funds collected → toggle, rendered directly under the
 *       leaderboard item (+ prepaid coin / TX-link proof inputs).
 *
 * DB policy: MAIN/prod game DB is READ-ONLY (the PFP + socials-count reads are
 * plain SELECTs via existing query helpers / `creatorsApi`). The only WRITES
 * are to the ADMIN DB (the manual row + the `completed_at` auto-hide snapshot).
 *
 * No-spam / lazy: every backend lookup is best-effort + timeout-guarded via
 * `safeQuery`; nothing here loops or polls. The checklist is rendered lazily by
 * its dock host (its own Suspense boundary), so these reads run only when the
 * checklist is mounted.
 *
 * Schema self-heal: `creator_onboarding_checklist` is an ADMIN-DB table that
 * may not be present on every environment yet. Every read/write path here
 * tolerates a missing relation (Postgres 42P01 / Prisma P2021) by degrading to
 * the empty manual state instead of throwing — matching the resilient pattern
 * in `@/lib/admin-settings`.
 */

const CHECKLIST_QUERY_TIMEOUT_MS = 8_000;

/** Persisted columns we read from `creator_onboarding_checklist`. */
type ChecklistRow = {
  lb_funds_collected: boolean;
  twitter_giveaway_done: boolean;
  twitter_giveaway_url: string | null;
  streaming_assets_provided: boolean;
  lb_prepaid_coin: string | null;
  lb_prepaid_tx_url: string | null;
  completed_at: Date | null;
};

/** True if an error is a "relation does not exist" (table not migrated yet). */
export function isChecklistTableMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("creator_onboarding_checklist") &&
    (msg.includes("does not exist") ||
      msg.includes("UndefinedTable") ||
      msg.includes("P2021") ||
      msg.includes("42P01") ||
      msg.includes("ColumnNotFound"))
  );
}

/**
 * Read the persisted manual row for a creator, degrading a missing table to
 * the empty state. Returns the raw row (or null) so callers that also need
 * `completed_at` can use it without a second query.
 */
async function readChecklistRow(
  targetUserId: string,
): Promise<ChecklistRow | null> {
  try {
    return await adminDb.creator_onboarding_checklist.findUnique({
      where: { target_user_id: targetUserId },
      select: {
        lb_funds_collected: true,
        twitter_giveaway_done: true,
        twitter_giveaway_url: true,
        streaming_assets_provided: true,
        lb_prepaid_coin: true,
        lb_prepaid_tx_url: true,
        completed_at: true,
      },
    });
  } catch (err) {
    if (isChecklistTableMissing(err)) {
      logWarn(
        "creator-hub.onboarding-checklist",
        "creator_onboarding_checklist table missing — degrading to empty manual state",
      );
      return null;
    }
    throw err;
  }
}

function rowToManual(row: ChecklistRow | null): ChecklistManualState {
  if (!row) return { ...EMPTY_MANUAL_STATE };
  return {
    twitterGiveawayDone: row.twitter_giveaway_done,
    twitterGiveawayUrl: row.twitter_giveaway_url,
    streamingAssetsProvided: row.streaming_assets_provided,
    lbFundsCollected: row.lb_funds_collected,
    lbPrepaidCoin: row.lb_prepaid_coin,
    lbPrepaidTxUrl: row.lb_prepaid_tx_url,
  };
}

/**
 * Persist the auto-hide snapshot. When every item is satisfied we stamp
 * `completed_at` (once); if an item later regresses we clear it so the panel
 * can re-appear. Best-effort + ADMIN-DB only; a missing table or transient
 * write failure is swallowed (the snapshot is a cache of "fully done", not the
 * source of truth — the live items already decide visibility this render).
 *
 * Only writes when the stored value actually needs to change, so a normal
 * render of an in-progress checklist performs NO write.
 */
async function syncCompletedSnapshot(
  targetUserId: string,
  complete: boolean,
  currentCompletedAt: Date | null,
  rowExists: boolean,
): Promise<void> {
  const shouldBeSet = complete;
  const isSet = currentCompletedAt != null;
  if (shouldBeSet === isSet) return; // nothing to do

  try {
    if (shouldBeSet) {
      // Upsert: the creator may have no manual row yet but still satisfy all
      // AUTO items + the manual defaults — stamp completion.
      await adminDb.creator_onboarding_checklist.upsert({
        where: { target_user_id: targetUserId },
        create: { target_user_id: targetUserId, completed_at: new Date() },
        update: { completed_at: new Date() },
        select: { id: true },
      });
    } else if (rowExists) {
      // Regressed: clear the snapshot so the panel reappears. Only touch an
      // existing row (no point creating one just to store null).
      await adminDb.creator_onboarding_checklist.update({
        where: { target_user_id: targetUserId },
        data: { completed_at: null },
        select: { id: true },
      });
    }
  } catch (err) {
    if (isChecklistTableMissing(err)) return;
    logWarn(
      "creator-hub.onboarding-checklist",
      "failed to sync completed_at snapshot (non-fatal)",
      err,
    );
  }
}

/**
 * Count linked social slots (ADMIN DB). Owner spec: "≥ 2 of {Twitter, Kick,
 * Discord ID, Reward page}" — each handle/URL is counted once when set.
 */
async function countSocials(targetUserId: string): Promise<number> {
  const rows = await adminDb.creator_socials.findMany({
    where: { target_user_id: targetUserId },
    select: {
      platform: true,
      username: true,
    },
  });

  let count = 0;
  for (const platform of ["twitter", "kick", "discord"] as const) {
    const row = rows.find((r) => r.platform === platform);
    if (isLinkedSocialUsername(row?.username)) count++;
  }

  const urls = await getCreatorSocialUrls(targetUserId).catch(() => null);
  if (urls?.rewardPageUrl?.trim()) count++;
  return count;
}

/**
 * Build the full checklist for one creator: derive the AUTO items from live
 * data, merge the persisted MANUAL state, compute progress, and sync the
 * auto-hide snapshot.
 *
 * Every external read is best-effort. If an AUTO source fails it is treated as
 * "not done" AND the result is flagged `partial: true`, which suppresses
 * auto-hide — a transient backend miss must never make a not-yet-onboarded
 * creator's checklist disappear.
 */
export async function getCreatorChecklist(
  targetUserId: string,
): Promise<CreatorChecklistData> {
  // Persisted manual row first (also gives us the prior completed_at + whether
  // a row exists, which the snapshot sync needs).
  const rowResult = await safeQuery(
    () => readChecklistRow(targetUserId),
    null as ChecklistRow | null,
    "creator-hub.onboarding-checklist.row",
    CHECKLIST_QUERY_TIMEOUT_MS,
  );
  const row = rowResult.data;
  const manual = rowToManual(row);

  // AUTO sources — all best-effort, in parallel.
  const [socialsRes, dealRes, lbRes, apiKeyRes, headerRes] = await Promise.all([
    safeQuery(
      () => countSocials(targetUserId),
      0,
      "creator-hub.onboarding-checklist.socials",
      CHECKLIST_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => creatorsApi.listDeals(targetUserId, { limit: 1, offset: 0 }),
      null,
      "creator-hub.onboarding-checklist.deals",
      CHECKLIST_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () =>
        affiliateLeaderboardsApi.list({
          creator_user_id: targetUserId,
          limit: 1,
        }),
      null,
      "creator-hub.onboarding-checklist.leaderboards",
      CHECKLIST_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => creatorsApi.getApiKeyStatus(targetUserId),
      null,
      "creator-hub.onboarding-checklist.apiKey",
      CHECKLIST_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getCreatorHeader(targetUserId),
      null,
      "creator-hub.onboarding-checklist.header",
      CHECKLIST_QUERY_TIMEOUT_MS,
    ),
  ]);

  const socialsCount = socialsRes.data;
  const hasDeal = (dealRes.data?.total ?? 0) > 0;
  const hasLeaderboard = (lbRes.data?.total ?? 0) > 0;
  const hasApiKey = apiKeyRes.data?.has_api_key === true;
  const hasPfp = Boolean(headerRes.data?.image?.trim());

  // A best-effort AUTO source failing → partial (suppresses auto-hide). The
  // socials count failing is also partial since it can't distinguish 0 from
  // "couldn't read".
  const partial =
    socialsRes.error !== null ||
    dealRes.error !== null ||
    lbRes.error !== null ||
    apiKeyRes.error !== null ||
    headerRes.error !== null;

  const items: ChecklistItem[] = [
    {
      id: "two_socials",
      kind: "auto",
      label: "Link at least 2 socials",
      hint: "Twitter, Kick, Discord ID, or reward-page URL on the Creator tab.",
      done: socialsCount >= MIN_SOCIALS,
      detail:
        socialsCount >= MIN_SOCIALS
          ? undefined
          : `${socialsCount}/${MIN_SOCIALS} linked — add more on the Creator tab.`,
    },
    {
      id: "first_deal",
      kind: "auto",
      label: "Set up the first deal",
      hint: "A creator deal exists.",
      done: hasDeal,
      detail: hasDeal ? undefined : "No deal yet — create one in the Overview.",
    },
    {
      id: "leaderboard",
      kind: "auto",
      label: "Set up a leaderboard",
      hint: "An affiliate leaderboard exists for this creator.",
      done: hasLeaderboard,
      detail: hasLeaderboard
        ? undefined
        : "No leaderboard yet — create one in the Overview.",
    },
    {
      id: "lb_funds_collected",
      kind: "manual",
      label: "Leaderboard funds collected",
      hint: "Mark once the creator has prepaid their leaderboard share off-site.",
      done: manual.lbFundsCollected,
    },
    {
      id: "api_key",
      kind: "auto",
      label: "Set up the API key",
      hint: "The creator has an API key.",
      done: hasApiKey,
      detail: hasApiKey
        ? undefined
        : "No API key yet — generate one for the creator.",
    },
    {
      id: "has_pfp",
      kind: "auto",
      label: "Creator has a profile picture",
      hint: "The packy.gg account has an avatar set.",
      done: hasPfp,
      detail: hasPfp ? undefined : "No avatar on the packy.gg account yet.",
    },
    {
      id: "twitter_giveaway",
      kind: "manual",
      label: "Twitter giveaway hosted",
      hint: "Mark when hosted and paste the giveaway tweet URL.",
      done: manual.twitterGiveawayDone,
    },
    {
      id: "streaming_assets",
      kind: "manual",
      label: "Streaming assets provided",
      hint: "Overlays / panels / banners handed to the creator.",
      done: manual.streamingAssetsProvided,
    },
  ];

  const doneCount = items.filter((i) => i.done).length;
  const totalCount = items.length;
  const allDone = doneCount === totalCount;

  // Only auto-hide when genuinely complete AND no source was partial.
  const complete = allDone && !partial;

  // Cache the "fully done" snapshot (best-effort). Skip the write entirely
  // while partial so a transient miss can't toggle the snapshot.
  if (!partial) {
    await syncCompletedSnapshot(
      targetUserId,
      complete,
      row?.completed_at ?? null,
      row != null,
    );
  }

  return {
    targetUserId,
    items,
    doneCount,
    totalCount,
    complete,
    completedAt:
      (complete ? new Date() : row?.completed_at ?? null)?.toISOString() ??
      null,
    manual,
    partial,
  };
}

/**
 * Lightweight progress-only read for the compact "5/8" badge on the roster.
 * Returns just the counts + complete flag so the badge surface doesn't pull
 * the full item list. Reuses {@link getCreatorChecklist} (cached by the React
 * request cache when both render in the same request) but exposes a narrow
 * shape so callers can't accidentally depend on the heavy fields.
 */
export type CreatorChecklistProgress = {
  doneCount: number;
  totalCount: number;
  complete: boolean;
  partial: boolean;
};

export async function getCreatorChecklistProgress(
  targetUserId: string,
): Promise<CreatorChecklistProgress> {
  const full = await getCreatorChecklist(targetUserId);
  return {
    doneCount: full.doneCount,
    totalCount: full.totalCount,
    complete: full.complete,
    partial: full.partial,
  };
}
