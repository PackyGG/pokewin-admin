import "server-only";

import { createHash, createHmac } from "crypto";

/**
 * Per-recipient promo codes for a reward campaign.
 *
 * The code for a given (campaign, user) is DERIVED, not random. That single
 * decision is what makes the whole campaign safe to retry:
 *
 *   • A chunk that times out mid-flight can be re-sent verbatim. Re-deriving
 *     produces the identical code, the identical hash, and therefore the
 *     identical promo_codes row — never a second code for the same user.
 *   • It pairs with the notification `dedupe_key` (`campaign:user_id`), so
 *     BOTH halves of a retry — the code and the notification — collapse onto
 *     what already exists instead of duplicating.
 *   • No mapping table, and no lookup by JSONB metadata (which would be a
 *     sequential scan). Recovering a user's code is pure computation.
 *
 * A random code would need one of those two things to be idempotent, and
 * would silently mint a second $N code per retried user if it had neither.
 *
 * The codes are still unguessable: they are HMAC output keyed on
 * GIFT_CARD_PEPPER, the same server secret that already protects code hashes.
 * Knowing the campaign slug and a user id gets you nothing without the key.
 * The HMAC message is domain-separated so this derivation can never collide
 * with any other use of that secret.
 */

/** Bump if the derivation ever changes — old campaigns keep their codes. */
const DERIVATION_DOMAIN = "packy.promo-campaign.v1";

/** Crockford-ish: no 0/O/1/I/L/U, so a code read aloud or off a screenshot
 * can't be mistyped into a different valid-looking code. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 3;
const GROUP_LEN = 4;

export const REWARD_CODE_PREFIX = "PACKY";

function requirePepper(): string {
  const pepper = process.env.GIFT_CARD_PEPPER;
  if (!pepper) {
    // Without the pepper the hash we store would not match what the backend
    // computes at redeem time, so every code would be silently unredeemable.
    // Fail loudly instead of minting thousands of dead codes.
    throw new Error(
      "GIFT_CARD_PEPPER is not set — reward codes would hash to values the backend can't resolve.",
    );
  }
  return pepper;
}

/**
 * `PACKY-XXXX-XXXX-XXXX` — 12 characters over a 30-symbol alphabet (~59 bits).
 * Deterministic for a given (campaign, userId).
 */
export function deriveRewardCode(campaign: string, userId: string): string {
  const mac = createHmac("sha256", requirePepper())
    .update(`${DERIVATION_DOMAIN}:${campaign}:${userId}`)
    .digest();

  let out = "";
  for (let i = 0; i < GROUPS * GROUP_LEN; i++) {
    // One byte per character. Modulo bias across 30 symbols is negligible at
    // this length and irrelevant to guessability, which rests on the key.
    out += ALPHABET[mac[i] % ALPHABET.length];
  }

  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    groups.push(out.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
  }
  return `${REWARD_CODE_PREFIX}-${groups.join("-")}`;
}

/**
 * The stored `code_hash`. MUST match the backend's hashing exactly
 * (`sha256(normalizedCode + pepper)`, see the admin's own createPromoCode and
 * packy-backend `utils/gift-card-hash`) — a mismatch means the code the user
 * types can never be resolved.
 */
export function hashRewardCode(code: string): string {
  return createHash("sha256")
    .update(code.toUpperCase().trim() + requirePepper())
    .digest("hex");
}

/** `continent_code` → `gift_card_region`. Mirrors the backend's
 * `mapContinentToRegion`. Promo-code region is recorded but NOT enforced at
 * redeem (only gift cards check it), so this exists to keep reporting honest
 * rather than to gate anyone. */
export function regionForContinent(continentCode: string | null): "NA" | "EU" {
  return continentCode === "NA" || continentCode === "SA" ? "NA" : "EU";
}
