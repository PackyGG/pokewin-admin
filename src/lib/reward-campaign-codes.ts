import "server-only";

import { createHash, createHmac } from "crypto";

import { readDbEnv } from "@/lib/db-env";

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

/**
 * The pepper for the environment we are writing to.
 *
 * THIS IS PER-ENVIRONMENT, and getting it wrong mints codes that look perfect
 * and cannot be redeemed. A stored `code_hash` is `sha256(code + pepper)`; at
 * redeem the backend recomputes it with ITS OWN pepper and looks the row up by
 * hash. Two different peppers means the lookup misses and the user is told
 * "Code not found" — which is exactly what happened on 2026-07-23: the admin
 * held one `GIFT_CARD_PEPPER` (prod's) while writing rows into the dev game
 * database, whose backend peppers with a different value.
 *
 * So the pepper has to follow the same env split the rest of the admin already
 * uses (`DATABASE_URL` / `DEV_DATABASE_URL`,
 * `BACKEND_API_URL_PROD` / `_DEV`): pick by the resolved db env, and refuse to
 * mint if the one we need is absent rather than silently peppering with "".
 */
export async function resolveCodePepper(): Promise<string> {
  const env = await readDbEnv();
  const pepper =
    env === "dev"
      ? (process.env.GIFT_CARD_PEPPER_DEV?.trim() ??
        process.env.DEV_GIFT_CARD_PEPPER?.trim())
      : (process.env.GIFT_CARD_PEPPER_PROD?.trim() ??
        process.env.GIFT_CARD_PEPPER?.trim());

  if (!pepper) {
    throw new Error(
      env === "dev"
        ? "GIFT_CARD_PEPPER_DEV is not set. Codes minted against the dev game DB must be peppered with the DEV backend's secret, or they hash to values it can't resolve and every one comes back 'Code not found'."
        : "GIFT_CARD_PEPPER is not set — reward codes would hash to values the backend can't resolve.",
    );
  }
  return pepper;
}

/**
 * `PACKY-XXXX-XXXX-XXXX` — 12 characters over a 30-symbol alphabet (~59 bits).
 * Deterministic for a given (campaign, userId).
 */
export function deriveRewardCode(
  campaign: string,
  userId: string,
  pepper: string,
): string {
  const mac = createHmac("sha256", pepper)
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
export function hashRewardCode(code: string, pepper: string): string {
  return createHash("sha256")
    .update(code.toUpperCase().trim() + pepper)
    .digest("hex");
}

/** `continent_code` → `gift_card_region`. Mirrors the backend's
 * `mapContinentToRegion`. Promo-code region is recorded but NOT enforced at
 * redeem (only gift cards check it), so this exists to keep reporting honest
 * rather than to gate anyone. */
export function regionForContinent(continentCode: string | null): "NA" | "EU" {
  return continentCode === "NA" || continentCode === "SA" ? "NA" : "EU";
}
