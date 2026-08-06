import { isIP } from "node:net";

import type { Databases } from "./db.js";
import type { Signal, Signup } from "./types.js";

export type IdentifierBlocklistKind = "ip" | "fingerprint";
export type IdentifierBlocklistEffect = "block" | "known_vpn";

/** Narrowest CIDR an operator may enter: /8 for IPv4, /32 for IPv6. */
export const MIN_IPV4_PREFIX_BITS = 8;
export const MIN_IPV6_PREFIX_BITS = 32;

export function validateIdentifierInput(
  kind: IdentifierBlocklistKind,
  value: string,
  matchMode: "exact" | "cidr",
): boolean {
  const trimmed = value.trim();
  if (kind === "fingerprint") {
    return (
      matchMode === "exact"
      && trimmed.length >= 4
      && trimmed.length <= 255
      && !/\s/.test(trimmed)
    );
  }
  const [address, prefix] = trimmed.split("/");
  const family = address ? isIP(address) : 0;
  if (!family) return false;
  if (matchMode === "exact") return prefix === undefined;
  if (prefix === undefined || !/^\d{1,3}$/.test(prefix)) return false;
  const bits = Number(prefix);
  // A near-zero prefix is a self-inflicted mass lock: `0.0.0.0/0` matches every signup, and a
  // `block` rule scores 100 points under hard policy -- a withdrawal lock plus staff review for
  // the entire player base. Floors are the widest range an operator could plausibly mean.
  const minimumBits = family === 4 ? MIN_IPV4_PREFIX_BITS : MIN_IPV6_PREFIX_BITS;
  return bits >= minimumBits && bits <= (family === 4 ? 32 : 128);
}

export async function captureIdentifierBlocklistMatches(
  db: Databases,
  signup: Signup,
): Promise<Signal[]> {
  const matches = await db.antifraud.query<{
    id: string;
    kind: IdentifierBlocklistKind;
    value: string;
    reason: string;
    effect: IdentifierBlocklistEffect;
  }>(
    `
      SELECT
        id,
        kind,
        CASE
          WHEN kind = 'ip' AND match_mode = 'exact' THEN host(ip_network)
          WHEN kind = 'ip' THEN ip_network::text
          ELSE fingerprint_id
        END AS value,
        reason,
        effect
      FROM identifier_blocklists
      WHERE enabled
        AND (expires_at IS NULL OR expires_at > now())
        AND (
          (
            kind = 'ip'
            AND $1::text IS NOT NULL
            AND pg_input_is_valid($1::text, 'inet')
            AND $1::inet <<= ip_network
          )
          OR
          (kind = 'fingerprint' AND fingerprint_id = $2)
        )
      ORDER BY kind, created_at
      LIMIT 20
    `,
    [signup.signup_ip, signup.visitor_id],
  );
  for (const match of matches.rows) {
    await db.antifraud.query(
      `
        INSERT INTO identifier_blocklist_matches (
          blocklist_id, user_id, source_ref, match_context, resulting_action,
          evidence, matched_at
        ) VALUES (
          $1,$2,$3,'signup',$4,
          jsonb_build_object('kind',$5::text,'value',$6::text,'effect',$7::text),
          $8
        )
        ON CONFLICT (blocklist_id, user_id, source_ref) DO NOTHING
      `,
      [
        match.id,
        signup.id,
        `signup:${signup.created_at.toISOString()}`,
        match.effect === "block" ? "lock_review" : "no_action",
        match.kind,
        match.value,
        match.effect,
        signup.created_at,
      ],
    );
  }
  return matches.rows.map((match) => match.effect === "known_vpn" ? ({
    key: "known_vpn_ip",
    title: "Known VPN IP",
    detail: `Network ${match.value} is a known shared VPN. This raises risk but never directly locks or opens review.`,
    points: 15,
    payload: {
      blocklistId: match.id,
      kind: match.kind,
      value: match.value,
      reason: match.reason,
      effect: match.effect,
    },
  }) : ({
    key:
      match.kind === "ip"
        ? "active_ip_blocklist"
        : "active_fingerprint_blocklist",
    title:
      match.kind === "ip"
        ? "Active IP blocklist match"
        : "Active fingerprint blocklist match",
    detail: `${match.kind === "ip" ? "Network" : "Fingerprint"} ${match.value} is actively blocked. The account requires a withdrawal lock and staff review.`,
    points: 100,
    payload: {
      blocklistId: match.id,
      kind: match.kind,
      value: match.value,
      reason: match.reason,
      effect: match.effect,
    },
  }));
}
