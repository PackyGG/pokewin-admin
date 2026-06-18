/**
 * Cloudflare "Creator Allow (affiliate stats)" WAF skip-rule — pure helpers.
 *
 * The rule whitelists requests to /v1/affiliate/stats either by source IP or
 * by an `x-custom-key` header value. We treat Cloudflare as the single source
 * of truth: read the rule, parse the two lists out of its expression, let an
 * admin edit them, then rebuild the expression and PATCH it back. No local
 * copy of the list, so nothing to drift.
 *
 * Kept separate from the "use server" actions file because that file may only
 * export async functions — these constants + pure functions live here so they
 * can also be unit-tested without a request scope.
 */

// Fixed identifiers for the one rule we manage. These never change; the only
// secret is CF_AUTH_TOKEN (env). Overridable via env for safety/rotation.
export const CF_ZONE_ID =
  process.env.CF_ZONE_ID ?? "370a2d8912e147217751cad2c10c8b24";
export const CF_RULESET_ID =
  process.env.CF_RULESET_ID ?? "9fcde724068243e98502d7076db0d4d6";
// Both rules in the ruleset share this same whitelist expression (they only
// differ in which WAF phases they skip), so a save must PATCH every one. The
// first id is the "primary" we read from. Override with a comma-separated env.
export const CF_RULE_IDS: string[] = (
  process.env.CF_RULE_IDS ??
  "9b52f264ea7442bf909d347ec8283ffc,e89f0454fb58471c96d64277b618a2f1"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export type Whitelist = { ips: string[]; keys: string[] };

const STATS_PATH = 'starts_with(http.request.uri.path, "/v1/affiliate/stats")';

// The two editable lists inside the expression. We match ONLY these slices, so
// any surrounding structure (the path guard, the `or`, the `any(...)` wrapper)
// is preserved verbatim when we rebuild.
const IP_LIST_RE = /ip\.src in \{([^}]*)\}/;
const KEY_LIST_RE = /x-custom-key"\]\[\*\] in \{([^}]*)\}/;

// Injection guards — every token is interpolated back into the expression
// string, so a token containing `}` `"` or whitespace could break out of its
// list. IPs: digits, dot, colon (v4/v6), optional CIDR. Keys: the UUID/hex
// alphabet only. Anything else is rejected before we build.
const IP_RE = /^[0-9a-fA-F.:]+(\/\d{1,3})?$/;
const KEY_RE = /^[A-Za-z0-9._-]+$/;

export const isValidIp = (s: string): boolean =>
  IP_RE.test(s) && (s.includes(".") || s.includes(":"));
export const isValidKey = (s: string): boolean => KEY_RE.test(s);

/**
 * Parse the IP + key lists out of the rule expression. Returns null if the
 * expression doesn't match the expected shape — the caller MUST refuse to
 * write in that case rather than blindly overwrite a hand-edited rule.
 */
export function parseRuleExpression(expression: string): Whitelist | null {
  const ipMatch = expression.match(IP_LIST_RE);
  const keyMatch = expression.match(KEY_LIST_RE);
  if (!ipMatch || !keyMatch) return null;

  const ips = ipMatch[1].trim().split(/\s+/).filter(Boolean);
  const keys = [...keyMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return { ips, keys };
}

/** Rebuild the full expression from edited lists. Mirrors the live rule shape. */
export function buildRuleExpression({ ips, keys }: Whitelist): string {
  const ipList = ips.join(" ");
  const keyList = keys.map((k) => `"${k}"`).join(" ");
  return (
    `(${STATS_PATH} and ip.src in {${ipList}}) or ` +
    `(${STATS_PATH} and any(http.request.headers["x-custom-key"][*] in {${keyList}}))`
  );
}

/** Normalize free-text textarea input (newlines/commas/spaces) into a list. */
export function parseList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
