/**
 * Pool-freshness fingerprint shared by the retune PLAN (preview) and WRITE
 * paths — the RC1 completion of the 2026-07-02 retune audit ("Approve
 * re-solves instead of writing what was approved").
 *
 * A retune proposal is solved from a snapshot of a pack's LIVE pool (ticket
 * price + per-card weights). Between the plan (`planAllRetunes` /
 * `planSingleRetune`, cached up to 60s) and the operator's Approve, that pool
 * can drift — another operator's edit, a card swap, a price change. The write
 * paths (`applyPackRetune` / `applyStagedPackEditAndRetune`) re-solve from the
 * FRESH pool, so a drifted pool silently produces a different price/odds than
 * the preview the operator approved. This fingerprint lets the write FAIL
 * CLOSED instead: the planner stamps every proposal with the fingerprint of
 * the pool it solved (`PlanAllProposal.poolFingerprint`), the review client
 * threads it back on Approve (`approvedPoolFingerprint`), and the write
 * recomputes it over the fresh pool and refuses on mismatch.
 *
 * Canonical input = `v1|<price 2dp>|<sorted "cardId:weight" pairs>` — the
 * exact solver inputs both sides read from MAIN (`pack_cards` INNER JOIN
 * `cards`; weight is an Int, price a Decimal(20,2) canonicalized via
 * `toFixed(2)`), sorted by pair string so row order can't matter. Card VALUES
 * are deliberately excluded: `cards.price` repricing moves independently of
 * the pool identity and already flows into the solve on both sides — the
 * approved-price equality gate (`approvedPriceAfter`, tolerance 0) catches a
 * value drift that changes the outcome, without bricking approves on every
 * irrelevant catalog tick.
 *
 * Deterministic + dependency-free (cyrb53 over the canonical string — pure
 * 32-bit integer math, no transcendentals, identical on every JS engine).
 * This is a FRESHNESS token, not a security boundary: every write still
 * re-validates all invariants (edge floor, caps, tag accuracy) server-side
 * regardless of what the client sends.
 */

/**
 * cyrb53 (bryc, public domain) — a fast, deterministic 53-bit string hash
 * built from `Math.imul`/xor/shift only (engine-independent). Two different
 * seeds are combined in {@link computePoolFingerprint} for ~106 bits, making
 * an accidental collision (a drifted pool passing as fresh) negligible.
 */
function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Fingerprint a pack's live pool state: the LIVE ticket price (USD) + the
 * (cardId, weight) pair of every pool row. Pure + order-insensitive — both
 * the plan side (`planAllRetunes` batched read) and the write side
 * (`getPackCardValues`) produce identical fingerprints for the same pool.
 */
export function computePoolFingerprint(
  price: number,
  cards: readonly { cardId: string; weight: number }[],
): string {
  const pairs = cards.map((c) => `${c.cardId}:${c.weight}`).sort();
  const canonical = `v1|${price.toFixed(2)}|${pairs.join(",")}`;
  return `${cyrb53(canonical, 0x51ab).toString(36)}-${cyrb53(canonical, 0xc0de).toString(36)}`;
}
