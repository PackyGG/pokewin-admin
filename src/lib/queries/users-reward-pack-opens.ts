import "server-only";
import { unstable_cache } from "next/cache";
import { queryMainRows } from "@/lib/drizzle-query";
import { readDbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { USERS_DETAIL_GLOBAL_TAG, userDetailTag } from "./users-detail-cache";

/**
 * Per-user REWARD / SIGN-UP PACK OPENS — the provenance trail for cards a
 * user received from a reward pack (welcome/onboarding pack, level-up packs,
 * daily/free packs, etc.) rather than from a paid pack open, a battle, or an
 * exchange.
 *
 * WHY THIS EXISTS
 * ───────────────
 * A reward pack (`packs.pack_type = 'reward'`) is an INVENTORY GIVEAWAY: the
 * house grants the cards straight into `user_inventory` with
 * `source_type = 'reward'` and a `bet_amount = 0` pack `game_sessions` row.
 * There is NO `ledger_transactions` entry for the GRANT itself (only a later
 * `reward_card_sale` row if the user sells the card back to balance). So an
 * admin looking at the ledger sees only the card SALES and cannot tell where
 * the cards came from. This query reconstructs the "opened a reward pack →
 * got these cards" story so the Rewards tab can show it.
 *
 * VERIFIED DATA PATH (read-only against live prod, 2026-06-14)
 * ───────────────────────────────────────────────────────────
 *   user_inventory (source_type='reward', source_id = the open's session id)
 *     → game_sessions  (game_type='pack', game_id = pack id, bet_amount = 0,
 *                       user_reward_id = the reward grant)
 *       → packs        (name, pack_type='reward')
 *       → user_rewards → rewards (slug/name e.g. 'onboarding' Welcome Reward,
 *                       'level-1' Level 1)
 *
 * `user_inventory.source_id` IS the pack-open `game_sessions.id` for reward
 * grants — confirmed: every reward-source inventory row resolved to exactly
 * one such session, every session had bet_amount = 0. This is the canonical,
 * index-backed link (the provably-fair chain via
 * provably_fair_results.inventory_item_id agrees but is a longer path; we use
 * source_id directly).
 *
 * HOUSE-POV (CLAUDE.md): a reward-pack grant is the house GIVING the user
 * value → from the house's perspective it is a COST. Card values here are
 * therefore presented in ROSE on the UI, consistent with every other reward
 * cost on the site. The dollar figures are small ($0.01-class cards are
 * common) but real.
 *
 * READ-ONLY. SELECT only — no writes, no game-data mutation. Safe against the
 * live production game DB.
 */

/** One card granted by a reward-pack open. */
type RewardPackOpenCard = {
  /** user_inventory.id (stable key). */
  inventoryId: string;
  cardName: string;
  rarity: string | null;
  /** USD value the card was booked at when obtained. */
  value: number;
  /** Still in the user's owned inventory (not sold/exchanged). */
  owned: boolean;
};

/** One reward-pack OPEN: the pack + reward it came from and the cards granted. */
export type RewardPackOpenEntry = {
  /** game_sessions.id of the open (stable key). Null only for legacy rows
   *  whose source_id didn't resolve to a session — grouped under one bucket. */
  sessionId: string | null;
  /** Reward pack name, e.g. "Welcome Pack" / "Level 1". Null if unresolved. */
  packName: string | null;
  /** `packs.image_url` — same thumbnail source the /packs list and the
   *  Daily Packs breakdown row use. Null if unresolved or the pack has no
   *  image; `CardImage` renders its neutral placeholder in that case. */
  packImageUrl: string | null;
  /** The reward program that granted the pack, e.g. "Welcome Reward". */
  rewardName: string | null;
  /** Reward slug, e.g. "onboarding" / "level-1". */
  rewardSlug: string | null;
  /** Reward type, e.g. "one_time" / "daily". */
  rewardType: string | null;
  /** When the pack was opened (ISO). Null if the session didn't resolve. */
  openedAt: string | null;
  /** Number of cards granted by this open. */
  cardCount: number;
  /** How many of those cards the user still owns. */
  ownedCount: number;
  /** Total USD value of the cards granted by this open. */
  totalValue: number;
  /** The granted cards (oldest first). */
  cards: RewardPackOpenCard[];
};

export type UserRewardPackOpensResult = {
  /** Distinct reward-pack open events. */
  totalOpens: number;
  /** Total cards granted across all reward-pack opens. */
  totalCards: number;
  /** Total USD value granted across all reward-pack opens (house cost). */
  totalValue: number;
  /** Per-open detail, newest first. */
  opens: RewardPackOpenEntry[];
};

const EMPTY_RESULT: UserRewardPackOpensResult = {
  totalOpens: 0,
  totalCards: 0,
  totalValue: 0,
  opens: [],
};

/** Cap on the number of distinct opens surfaced (newest first). A user has at
 *  most a handful of reward packs in practice; the cap is a safety bound. */
const OPENS_LIMIT = 100;

type RawCard = {
  invId: string;
  card: string;
  rarity: string | null;
  value: string | number | null;
  owned: boolean;
};

type RawOpenRow = {
  session_id: string | null;
  pack_name: string | null;
  pack_image_url: string | null;
  reward_slug: string | null;
  reward_name: string | null;
  reward_type: string | null;
  opened_at: Date | string | null;
  card_count: number | bigint;
  owned_count: number | bigint;
  total_value: string | number | null;
  cards: RawCard[] | null;
};

async function queryUserRewardPackOpens(
  userId: string,
): Promise<UserRewardPackOpensResult> {
  // One scoped read: the user's reward-source inventory rows, grouped by the
  // pack-open session, resolved to the pack + reward that granted them, with
  // the granted cards aggregated into a JSON array. Same `user_id`-scoped
  // access pattern as getUserInventory. All joins LEFT so a legacy row with an
  // unresolved source_id still surfaces (bucketed under session_id IS NULL)
  // instead of vanishing.
  const rows = await queryMainRows<RawOpenRow[]>(
    `
    WITH reward_items AS (
      SELECT ui.id AS inv_id, ui.source_id AS session_id, ui.card_id,
             ui.value_at_obtained, ui.obtained_at,
             (ui.sold_at IS NULL AND ui.exchanged_at IS NULL) AS owned
        FROM user_inventory ui
       WHERE ui.user_id = $1
         AND ui.source_type = 'reward'::source_type
    )
    SELECT
      ri.session_id::text AS session_id,
      p.name AS pack_name,
      MAX(p.image_url) AS pack_image_url,
      r.slug AS reward_slug,
      r.name AS reward_name,
      r.type::text AS reward_type,
      gs.created_at AS opened_at,
      COUNT(*)::int AS card_count,
      SUM(CASE WHEN ri.owned THEN 1 ELSE 0 END)::int AS owned_count,
      COALESCE(SUM(ri.value_at_obtained::numeric), 0)::text AS total_value,
      jsonb_agg(
        jsonb_build_object(
          'invId', ri.inv_id::text,
          'card', c.name,
          'rarity', c.rarity,
          'value', ri.value_at_obtained::text,
          'owned', ri.owned
        ) ORDER BY ri.obtained_at ASC
      ) AS cards
    FROM reward_items ri
    JOIN cards c ON c.id = ri.card_id
    LEFT JOIN game_sessions gs ON gs.id = ri.session_id
    LEFT JOIN packs p ON p.id = gs.game_id
    LEFT JOIN user_rewards ur ON ur.id = gs.user_reward_id
    LEFT JOIN rewards r ON r.id = ur.reward_id
    GROUP BY ri.session_id, p.name, r.slug, r.name, r.type, gs.created_at
    ORDER BY gs.created_at DESC NULLS LAST
    LIMIT $2
  `,
    userId,
    OPENS_LIMIT,
  );

  if (rows.length === 0) return EMPTY_RESULT;

  let totalCards = 0;
  let totalValue = 0;

  const opens: RewardPackOpenEntry[] = rows.map((row) => {
    const cardCount = Number(row.card_count ?? 0);
    const ownedCount = Number(row.owned_count ?? 0);
    const value = toNumber(row.total_value ?? 0);
    totalCards += cardCount;
    totalValue += value;

    const cards: RewardPackOpenCard[] = (row.cards ?? []).map((c) => ({
      inventoryId: c.invId,
      cardName: c.card ?? "Unknown Card",
      rarity: c.rarity ?? null,
      value: toNumber(c.value ?? 0),
      owned: Boolean(c.owned),
    }));

    return {
      sessionId: row.session_id,
      packName: row.pack_name,
      packImageUrl: row.pack_image_url,
      rewardName: row.reward_name,
      rewardSlug: row.reward_slug,
      rewardType: row.reward_type,
      openedAt:
        row.opened_at == null
          ? null
          : row.opened_at instanceof Date
            ? new Date(row.opened_at).toISOString()
            : String(row.opened_at),
      cardCount,
      ownedCount,
      totalValue: value,
      cards,
    };
  });

  return {
    totalOpens: opens.length,
    totalCards,
    totalValue,
    opens,
  };
}

// Env-keyed cache wrapper — identical reasoning to users-shard-winnings.ts /
// users-detail-cache.ts: `unstable_cache` runs OUTSIDE the request's dynamic
// scope, so caching a dev-toggled request would serve PROD data to a dev
// admin. Cache ONLY on prod (the default hot path); a dev-toggled admin runs
// the query directly so they always see live dev data. The cached payload is
// JSON-serialisable (openedAt is already an ISO string, no Date to re-coerce
// on a cache hit).
// Per-user tags: tags depend on the userId, so the wrapper is created per
// call. `unstable_cache` identifies the entry by `keyParts` (which already
// carry the userId via the function arg), not by closure identity. See
// `users-detail-cache.ts` for the canonical pattern + tag helpers.
function cachedByUser(userId: string): Promise<UserRewardPackOpensResult> {
  return unstable_cache(
    (): Promise<UserRewardPackOpensResult> => queryUserRewardPackOpens(userId),
    // v2: bumped when `packImageUrl` was added to the row shape, so stale
    // v1-cached entries (pre-image-column) don't linger under the same key.
    ["users-reward-pack-opens-v2", userId],
    {
      revalidate: 60,
      tags: [USERS_DETAIL_GLOBAL_TAG, userDetailTag(userId)],
    },
  )();
}

/**
 * Public entry point. Returns the user's reward / sign-up pack opens and the
 * cards each granted. Cached 60s on prod; direct (uncached) on a dev-toggled
 * admin. ACTIVE-TIMEFRAME-ONLY: the caller kicks this ONLY when the Rewards
 * tab is active.
 */
export async function getUserRewardPackOpens(
  userId: string,
): Promise<UserRewardPackOpensResult> {
  const env = await readDbEnv();
  if (env !== "prod") return queryUserRewardPackOpens(userId);
  return cachedByUser(userId);
}
