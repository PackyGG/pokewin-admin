import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  ggr as ggrFormula,
  empiricalHouseEdge,
} from "@/lib/metrics/formulas";

/**
 * Edge Calc — theoretical EV / RTP / house-edge math for packs and the
 * upgrader. The page surfaces *theoretical* numbers (computed straight
 * off the pool composition × prices) alongside *empirical* numbers
 * (lifetime totals already maintained on the `packs` table by the
 * backend pack-opening pipeline). The two columns sitting side by side
 * lets an admin see at a glance when a pack's realized RTP has drifted
 * from what the catalog math says it should be.
 *
 * Why theoretical math is sourced from `pack_cards`:
 *   Every pack opening picks N cards from the pool weighted by
 *   `pack_cards.weight`. Per-pick expected card value E[V] is:
 *     E[V] = SUM(weight_i × price_i) / SUM(weight_i)
 *   And the expected total payout per open at `cards_per_open` picks is:
 *     E[Payout] = cards_per_open × E[V]
 *   Theoretical RTP = E[Payout] / pack.price, edge = 1 − RTP.
 *
 *   This assumes WITH-replacement picks (each card is drawn
 *   independently from the same weighted pool). That's how the backend
 *   actually opens packs — every card slot rolls the PF function
 *   independently — so the math is exact for the catalog, not just a
 *   probabilistic approximation. Documented here so a future reader
 *   doesn't try to "fix" it with a without-replacement adjustment.
 *
 * NOTE about empirical numbers:
 *   `packs.actual_rtp` / `actual_house_edge` are maintained by the
 *   backend pipeline and stored as fractions (or percentages — see
 *   `getPackStats` for the >2 normalize trick already in use). We keep
 *   the same normalize convention here so callers don't reimplement
 *   the heuristic.
 */

// ─── Pack EV ──────────────────────────────────────────────────────────

export type PackEdgeRow = {
  /** UUID of the pack. */
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  /** Sticker price the user pays per open. */
  priceUsd: number;
  /** How many cards the backend draws per open (independent picks). */
  cardsPerOpen: number;
  /** Number of distinct cards in the pool. */
  poolSize: number;
  /** Sum of `pack_cards.weight` for this pack. */
  totalWeight: number;
  /**
   * Expected value of ONE card draw from this pack's weighted pool, in
   * USD. SUM(weight × price) / SUM(weight). Null when the pool is empty
   * (no cards configured yet).
   */
  expectedCardValue: number | null;
  /**
   * Expected total payout per OPEN — `expectedCardValue × cardsPerOpen`.
   * Null when no pool.
   */
  expectedPayoutPerOpen: number | null;
  /**
   * Theoretical RTP = expectedPayoutPerOpen / priceUsd. Null when no
   * pool or price is zero (free pack). Stored as a 0-1 fraction so the
   * UI can format it as % itself.
   */
  theoreticalRtp: number | null;
  /**
   * Theoretical house edge = 1 − theoreticalRtp. Null when RTP is null.
   * Positive = house in the green theoretically; negative = catalog math
   * says the pack pays MORE than it costs (a "loss leader" — usually
   * intentional only for promo packs).
   */
  theoreticalHouseEdge: number | null;
  /** Backend-maintained lifetime open count. */
  totalOpenings: number;
  /** Backend-maintained lifetime revenue (USD) — kept up to date by the open pipeline. */
  totalRevenue: number;
  /** Backend-maintained lifetime payout (USD). */
  totalPayout: number;
  /**
   * Empirical RTP — same source as /packs catalog hero (uses revenue +
   * payout columns the backend keeps on `packs`). Normalized to a 0-1
   * fraction; null when the pack has never been opened.
   */
  empiricalRtp: number | null;
  empiricalHouseEdge: number | null;
  /** True when the pack is live for users. */
  active: boolean;
  /** Min card price in pool (for the per-card breakdown column). Null when empty. */
  minCardPrice: number | null;
  /** Max card price in pool. Null when empty. */
  maxCardPrice: number | null;
};

/**
 * List every ACTIVE pack in the catalog with its theoretical EV
 * computed in the same pass. One round-trip — Prisma joins
 * `pack_cards.cards` and we do the SUM(weight × price) on the JS side
 * because Decimal columns coming through `db.$queryRaw` would need
 * extra normalization that Prisma's nested include already handles for
 * us. The catalog size is bounded (dozens of packs) so the per-card
 * fan-out is fine.
 *
 * Inactive packs (`packs.active = false`) are excluded entirely — they
 * are not live for users, so their EV / RTP / house-edge math is noise
 * on this surface. The filter sits at the query so every consumer (the
 * Packs table, the catalog-level aggregate KPIs/edge, the Scenario and
 * Bonus pack pickers, and the CSV export) drops them in one place.
 */
export async function getPackEdgeRows(): Promise<PackEdgeRow[]> {
  const db = await getDb();
  const packs = await db.packs.findMany({
    where: { active: true },
    select: {
      id: true,
      name: true,
      slug: true,
      image_url: true,
      price: true,
      cards_per_open: true,
      total_openings: true,
      total_revenue: true,
      total_payout: true,
      actual_rtp: true,
      active: true,
      pack_cards: {
        select: {
          weight: true,
          cards: { select: { price: true } },
        },
      },
    },
    orderBy: { name: "asc" },
  });

  return packs.map((p) => {
    const price = toNumber(p.price);
    const cardsPerOpen = p.cards_per_open ?? 0;

    let totalWeight = 0;
    let weightedSum = 0;
    let minPrice: number | null = null;
    let maxPrice: number | null = null;

    for (const pc of p.pack_cards) {
      const w = pc.weight ?? 0;
      const cardPrice = toNumber(pc.cards.price);
      if (w <= 0) continue;
      totalWeight += w;
      weightedSum += w * cardPrice;
      if (minPrice === null || cardPrice < minPrice) minPrice = cardPrice;
      if (maxPrice === null || cardPrice > maxPrice) maxPrice = cardPrice;
    }

    const hasPool = totalWeight > 0;
    const expectedCardValue = hasPool ? weightedSum / totalWeight : null;
    const expectedPayoutPerOpen =
      expectedCardValue !== null ? expectedCardValue * cardsPerOpen : null;
    const theoreticalRtp =
      expectedPayoutPerOpen !== null && price > 0
        ? expectedPayoutPerOpen / price
        : null;
    const theoreticalHouseEdge =
      theoreticalRtp !== null ? 1 - theoreticalRtp : null;

    // Empirical RTP/edge — same normalize convention as
    // `getPackStats` (column stored as percentage when >2).
    const totalRevenue = toNumber(p.total_revenue);
    const totalPayout = toNumber(p.total_payout);
    const dbRtp = toNumber(p.actual_rtp);
    const empiricalRtp =
      totalRevenue > 0 || dbRtp > 0
        ? dbRtp > 2
          ? dbRtp / 100
          : dbRtp
        : null;
    const empiricalHouseEdge =
      empiricalRtp !== null ? 1 - empiricalRtp : null;

    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      imageUrl: p.image_url,
      priceUsd: price,
      cardsPerOpen,
      poolSize: p.pack_cards.length,
      totalWeight,
      expectedCardValue,
      expectedPayoutPerOpen,
      theoreticalRtp,
      theoreticalHouseEdge,
      totalOpenings: Number(p.total_openings),
      totalRevenue,
      totalPayout,
      empiricalRtp,
      empiricalHouseEdge,
      active: p.active,
      minCardPrice: minPrice,
      maxCardPrice: maxPrice,
    };
  });
}

// ─── Pack pool detail (for the scenario builder's pack picker) ────────

export type PackPoolDetail = {
  id: string;
  name: string;
  slug: string;
  priceUsd: number;
  cardsPerOpen: number;
  totalWeight: number;
  expectedCardValue: number | null;
  expectedPayoutPerOpen: number | null;
  theoreticalRtp: number | null;
  theoreticalHouseEdge: number | null;
  /** Per-card breakdown sorted by descending probability for the panel. */
  pool: Array<{
    cardId: string;
    name: string;
    priceUsd: number;
    weight: number;
    /** weight / totalWeight as a 0-1 probability per draw. */
    probability: number;
    /** weight × price contribution to E[V] per draw. */
    contribution: number;
  }>;
};

export async function getPackPoolDetail(
  packId: string,
): Promise<PackPoolDetail | null> {
  const db = await getDb();
  const pack = await db.packs.findUnique({
    where: { id: packId },
    select: {
      id: true,
      name: true,
      slug: true,
      price: true,
      cards_per_open: true,
      pack_cards: {
        select: {
          card_id: true,
          weight: true,
          cards: { select: { name: true, price: true } },
        },
      },
    },
  });
  if (!pack) return null;

  const totalWeight = pack.pack_cards.reduce(
    (sum, pc) => sum + (pc.weight ?? 0),
    0,
  );
  const weightedSum = pack.pack_cards.reduce(
    (sum, pc) => sum + (pc.weight ?? 0) * toNumber(pc.cards.price),
    0,
  );
  const expectedCardValue = totalWeight > 0 ? weightedSum / totalWeight : null;
  const expectedPayoutPerOpen =
    expectedCardValue !== null ? expectedCardValue * pack.cards_per_open : null;
  const price = toNumber(pack.price);
  const theoreticalRtp =
    expectedPayoutPerOpen !== null && price > 0
      ? expectedPayoutPerOpen / price
      : null;
  const theoreticalHouseEdge =
    theoreticalRtp !== null ? 1 - theoreticalRtp : null;

  // Sort by descending contribution so the cards with the biggest pull
  // on E[V] sit at the top of the picker's breakdown panel.
  const pool = pack.pack_cards
    .map((pc) => {
      const w = pc.weight ?? 0;
      const cardPrice = toNumber(pc.cards.price);
      return {
        cardId: pc.card_id,
        name: pc.cards.name,
        priceUsd: cardPrice,
        weight: w,
        probability: totalWeight > 0 ? w / totalWeight : 0,
        contribution: w * cardPrice,
      };
    })
    .sort((a, b) => b.contribution - a.contribution);

  return {
    id: pack.id,
    name: pack.name,
    slug: pack.slug,
    priceUsd: price,
    cardsPerOpen: pack.cards_per_open,
    totalWeight,
    expectedCardValue,
    expectedPayoutPerOpen,
    theoreticalRtp,
    theoreticalHouseEdge,
    pool,
  };
}

// ─── Upgrader edge (empirical) ─────────────────────────────────────────

export type UpgraderTargetRow = {
  /** Target multiplier the user picked (rounded to one decimal). */
  multiplier: number;
  /** Number of upgrader rounds at this target in the empirical sample. */
  bets: number;
  /** Wins at this target. */
  wins: number;
  /** Total bet volume (USD). */
  wager: number;
  /** Total wins paid (USD). */
  payouts: number;
  /** Empirical win-rate: wins / bets. */
  hitRate: number;
  /**
   * Empirical house edge: (wager − payouts) / wager, house POV. From the
   * canonical sample-guarded `empiricalHouseEdge`: `null` below
   * `MIN_SAMPLE` bets — a thin target bucket reports the insufficient-
   * sample sentinel instead of a small-sample −14.92% / 114.92% figure
   * (those were variance, not a formula bug).
   */
  empiricalHouseEdge: number | null;
  /**
   * Theoretical win-chance for a fair game at this multiplier with the
   * house edge derived from the same row: chance ≈ (1 − edge) / mult.
   * Surfaced next to the empirical hit-rate so an admin can spot
   * targets where realized variance has drifted from the math. `null`
   * when the empirical edge is below sample (it is derived from it).
   */
  theoreticalChance: number | null;
};

/**
 * Upgrader empirical edge per target-multiplier bucket. Reads from the
 * same `upgrader_games + provably_fair_results` join the
 * /transactions/upgrader page uses — same JS-side metadata parsing —
 * so the buckets here are derived from real plays, not from a config
 * table (the backend doesn't expose one to the admin DB and the user-
 * facing upgrader uses a continuous multiplier slider).
 *
 * Multipliers are rounded to one decimal so 5.00 and 5.001 land in the
 * same bucket; admins typically only care about whole-number tiers
 * (2×, 5×, 10×, ...) anyway. Empty buckets (no plays) are filtered out
 * so the table only shows tiers users have actually run.
 */
export async function getUpgraderEdgeByTarget(): Promise<UpgraderTargetRow[]> {
  const db = await getDb();

  // Pull every settled upgrader game with its PF metadata blob via a
  // LATERAL pick of the lowest-cursor PF row — same lateral pattern the
  // transactions list uses to keep the join cardinality at exactly one
  // PF row per upgrader game.
  type Raw = {
    bet: string;
    won: string;
    metadata: unknown;
  };

  const rows = await db.$queryRaw<Raw[]>`
    SELECT
      g.bet_amount::text AS bet,
      g.won_amount::text AS won,
      pf.result_metadata AS metadata
    FROM upgrader_games g
    LEFT JOIN game_sessions gs
      ON gs.game_type = 'upgrader' AND gs.game_id = g.id
    LEFT JOIN LATERAL (
      SELECT result_metadata
      FROM provably_fair_results
      WHERE game_session_id = gs.id
      ORDER BY cursor ASC
      LIMIT 1
    ) pf ON true
  `;

  // Aggregate in-process — keeps the SQL straightforward (no JSON
  // extraction in the GROUP BY, no normalization branches) and the row
  // count is bounded by the upgrader_games volume which is small enough
  // for an in-memory roll-up.
  const buckets = new Map<
    number,
    { bets: number; wins: number; wager: number; payouts: number }
  >();

  for (const r of rows) {
    const meta = r.metadata;
    const mult = readMultiplierFromMetadata(meta);
    if (mult === null || mult <= 1) continue;
    const key = Math.round(mult * 10) / 10;
    const bet = Number(r.bet);
    const won = Number(r.won);
    const entry = buckets.get(key) ?? { bets: 0, wins: 0, wager: 0, payouts: 0 };
    entry.bets += 1;
    entry.wager += bet;
    entry.payouts += won;
    if (won > 0) entry.wins += 1;
    buckets.set(key, entry);
  }

  return [...buckets.entries()]
    .map(([multiplier, b]) => {
      // Empirical edge from the canonical sample-guarded helper: `null`
      // below MIN_SAMPLE bets, so a thin target bucket renders the
      // insufficient-sample sentinel rather than a small-sample
      // −14.92% / 114.92% edge (M7/M8 were variance, not formula bugs).
      const edge = empiricalHouseEdge({
        wager: b.wager,
        ggr: ggrFormula({ wager: b.wager, gamingPayout: b.payouts }),
        bets: b.bets,
      });
      // Theoretical chance: (1 − edge) / mult. Only derivable when the
      // edge cleared the sample guard — otherwise it would inherit the
      // same small-sample noise, so it is null too.
      const theoreticalChance =
        edge !== null && multiplier > 1
          ? Math.min(1, (1 - edge) / multiplier)
          : null;
      return {
        multiplier,
        bets: b.bets,
        wins: b.wins,
        wager: b.wager,
        payouts: b.payouts,
        hitRate: b.bets > 0 ? b.wins / b.bets : 0,
        empiricalHouseEdge: edge,
        theoreticalChance,
      };
    })
    .sort((a, b) => a.multiplier - b.multiplier);
}

// ─── Helper — extract target_multiplier from PF metadata ──────────────
//
// Lightweight duplicate of `parseUpgraderMetadata`'s multiplier pick —
// inlined here because pulling the full parser into this query module
// would only buy us back the houseEdge/roll fields we don't use, and
// the full parser lives under utils/ (called from React-only files) so
// we keep this module's import surface tight.

const MULTIPLIER_KEYS = [
  "target_multiplier",
  "targetMultiplier",
  "multiplier",
  "target_payout",
  "payout_multiplier",
  "cashout_multiplier",
  "cashout",
  "payout",
] as const;

function readMultiplierFromMetadata(metadata: unknown): number | null {
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  for (const key of MULTIPLIER_KEYS) {
    if (!(key in record)) continue;
    const v = record[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

// ─── Upgrader pool stats (theoretical, from the output pool) ─────────
//
// The backend serves the upgrader output pool via an API
// (upgraderApi.listOutputs); we keep a thin wrapper here so the page can
// fold it into the same load that fetches pack EV. This function returns
// only the aggregate stats — the per-card grid is already on /upgrader.

export type UpgraderPoolStats = {
  poolSize: number;
  enabledCount: number;
  /** Sum of card prices currently enabled in the pool — the "fair" payout
   *  pot the upgrader can land on. */
  enabledValueTotal: number;
  /** Min price in the enabled pool. */
  minEnabledPrice: number;
  /** Max price in the enabled pool. */
  maxEnabledPrice: number;
  /** Number of distinct prices represented (rough tier-spread proxy). */
  distinctPrices: number;
};

/**
 * Aggregate stats over the upgrader output pool — same source as the
 * /upgrader page's hero strip (upgraderApi.listOutputs) so the two
 * surfaces agree. Returned as a single bundle to keep the page-level
 * loader simple.
 */
export async function getUpgraderPoolStats(): Promise<UpgraderPoolStats> {
  const { upgraderApi } = await import("@/lib/backend-api/upgrader");
  const outputs = await upgraderApi.listOutputs();

  let enabledCount = 0;
  let enabledValueTotal = 0;
  let minEnabledPrice = Number.POSITIVE_INFINITY;
  let maxEnabledPrice = 0;
  const distinctPrices = new Set<number>();
  for (const o of outputs) {
    if (!o.enabled) continue;
    enabledCount += 1;
    enabledValueTotal += o.price;
    if (o.price < minEnabledPrice) minEnabledPrice = o.price;
    if (o.price > maxEnabledPrice) maxEnabledPrice = o.price;
    distinctPrices.add(o.price);
  }
  if (enabledCount === 0) minEnabledPrice = 0;

  return {
    poolSize: outputs.length,
    enabledCount,
    enabledValueTotal,
    minEnabledPrice,
    maxEnabledPrice,
    distinctPrices: distinctPrices.size,
  };
}
