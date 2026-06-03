/**
 * TCGplayer link ⇄ product-id helpers, shared by the card create form
 * (client), the create-card server action (server, authoritative), the
 * edit dialog (client), and the card-detail page (server display).
 *
 * Why a URL field but an integer column:
 * The `cards` table has a single `tcgplayer_id Int? @unique` column and no
 * free text/url column. Rather than add a schema migration (the live main
 * DB auto-deploys, so we can't ship a Prisma column ahead of the column
 * existing in prod), we keep storing the numeric TCGplayer **product id**
 * in that existing column. The URL is purely the operator-facing INPUT
 * format (paste the product link) and OUTPUT format (rendered back as a
 * clickable link). The slug part of the pasted URL — e.g. the
 * "/one-piece-…-monkey-d-luffy" tail after the id — is NOT retained; the
 * canonical product URL is reconstructed from the id alone on display.
 * That is the accepted no-migration tradeoff.
 *
 * Pure functions only (no server-only imports) so this module is safe to
 * import from both "use client" components and server actions.
 */

/**
 * Match a TCGplayer product URL and capture the numeric product id.
 *
 * Robust to: with/without scheme, with/without `www.`, an optional country
 * subdomain, a trailing slug, and a query string / fragment. Examples that
 * parse to `517800`:
 *   https://www.tcgplayer.com/product/517800/one-piece-...-monkey-d-luffy
 *   https://tcgplayer.com/product/517800
 *   tcgplayer.com/product/517800?Language=English
 *   http://www.tcgplayer.com/product/517800/
 *
 * The host is anchored to a `tcgplayer.com` domain (optionally prefixed by
 * a sub-label like `www.` or `mp.`) so an arbitrary `…/product/123` URL on
 * another site is rejected.
 */
const TCGPLAYER_PRODUCT_RE =
  /(?:^|\/\/|\.)tcgplayer\.com\/product\/(\d+)(?:[/?#]|$)/i;

/**
 * Parse the TCGplayer product id out of a pasted product URL.
 * Returns the integer product id, or `null` if the string is not a valid
 * TCGplayer product link. Whitespace is trimmed first; an empty string
 * yields `null`.
 *
 * A bare numeric string (e.g. "517800") is intentionally NOT accepted here
 * — the field is a *link* field. Callers that still want to tolerate a raw
 * id can check `Number.isInteger(Number(value))` themselves; the create
 * flow requires a real link for OnePiece.
 */
export function parseTcgplayerProductId(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = trimmed.match(TCGPLAYER_PRODUCT_RE);
  if (!match) return null;
  const id = Number.parseInt(match[1], 10);
  // Guard against absurd lengths overflowing a safe integer (the column is
  // a Postgres int; real product ids are ~6 digits).
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return id;
}

/**
 * Reconstruct the canonical TCGplayer product URL from a stored product id.
 * The slug is not stored, so the bare `/product/<id>` form is used — it
 * resolves correctly on TCGplayer (it redirects to the slugged URL).
 */
export function tcgplayerProductUrl(productId: number): string {
  return `https://www.tcgplayer.com/product/${productId}`;
}

/**
 * Shared, operator-facing validation message for an invalid/missing
 * TCGplayer link. Kept in one place so the client form and the server
 * action surface identical copy.
 */
export const TCGPLAYER_LINK_ERROR =
  "Enter a valid TCGplayer product link (…/product/<id>/…)";
