"use server";

import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  CF_ZONE_ID,
  CF_RULESET_ID,
  CF_RULE_IDS,
  parseRuleExpression,
  buildRuleExpression,
  isValidIp,
  isValidKey,
  type Whitelist,
} from "./_lib/cloudflare-whitelist";

/**
 * Manage the Cloudflare "Creator Allow (affiliate stats)" WAF skip-rule.
 *
 * Cloudflare is the single source of truth: read the rule, parse its two
 * lists, edit, rebuild, PATCH back. The CF API token lives in CF_AUTH_TOKEN
 * on this (Vercel) deployment — it never touches the main backend.
 *
 * Gated on /creators page access (same as the creator API-key actions). Both
 * read + write fail closed if the rule no longer matches the expected shape,
 * so a hand-edit in the Cloudflare dashboard can't be silently clobbered.
 */

const CF_API = "https://api.cloudflare.com/client/v4";

const cfToken = (): string => {
  const token = process.env.CF_AUTH_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "CF_AUTH_TOKEN is not set. Add it to this deployment's env (Vercel) to manage the whitelist.",
    );
  }
  return token;
};

type CfRule = {
  id: string;
  expression: string;
  // Everything else is opaque — we round-trip it untouched on PATCH.
  [k: string]: unknown;
};

const cfError = (body: unknown, fallback: string): string => {
  const errs = (body as { errors?: { message?: string }[] })?.errors;
  return errs?.length ? errs.map((e) => e.message).join("; ") : fallback;
};

/** Fetch every rule in the ruleset (one GET serves both read + write paths). */
async function fetchRules(): Promise<CfRule[]> {
  const res = await fetch(
    `${CF_API}/zones/${CF_ZONE_ID}/rulesets/${CF_RULESET_ID}`,
    {
      headers: { Authorization: `Bearer ${cfToken()}` },
      cache: "no-store",
    },
  );
  const body = await res.json();
  if (!res.ok) {
    throw new Error(cfError(body, `Cloudflare GET failed (HTTP ${res.status})`));
  }
  return body?.result?.rules ?? [];
}

/** Find a target rule by id, or throw if it's gone from the ruleset. */
function requireRule(rules: CfRule[], id: string): CfRule {
  const rule = rules.find((r) => r.id === id);
  if (!rule) {
    throw new Error(`Rule ${id} not found in ruleset ${CF_RULESET_ID}.`);
  }
  return rule;
}

export async function getWhitelist(): Promise<Whitelist> {
  const session = await requirePageAccess("/creators");
  // Capability tier on top of page access: the parsed rule includes the WAF
  // BYPASS KEYS, i.e. a live credential for skipping the production edge
  // protections. Anyone with /creators could read them before. Admins and
  // the owner bypass inside `requireCapability`.
  await requireCapability(
    session,
    "__can_view_creator_waf_whitelist",
    "view the Cloudflare WAF whitelist",
  );
  // Both managed rules share the same whitelist — read from the primary.
  const rule = requireRule(await fetchRules(), CF_RULE_IDS[0]);
  const parsed = parseRuleExpression(rule.expression);
  if (!parsed) {
    throw new Error(
      "The Cloudflare rule no longer matches the expected shape — it was edited by hand. Fix it in the dashboard before using this editor.",
    );
  }
  return parsed;
}

export async function saveWhitelist(next: Whitelist): Promise<Whitelist> {
  const session = await requirePageAccess("/creators");
  // Write tier: this PATCHes PRODUCTION Cloudflare WAF rules. Page access
  // alone is not enough — /creators is a broad read permission.
  await requireCapability(
    session,
    "__can_edit_creator_waf_whitelist",
    "edit the Cloudflare WAF whitelist",
  );

  const ips = [...new Set(next.ips.map((s) => s.trim()).filter(Boolean))];
  const keys = [...new Set(next.keys.map((s) => s.trim()).filter(Boolean))];

  const badIp = ips.find((s) => !isValidIp(s));
  if (badIp) throw new Error(`Invalid IP/CIDR: "${badIp}"`);
  const badKey = keys.find((s) => !isValidKey(s));
  if (badKey) throw new Error(`Invalid key: "${badKey}"`);

  // Re-read first so we (a) verify EVERY managed rule still matches our
  // template before overwriting any of them, and (b) round-trip each rule's
  // own fields (they differ in `phases`) untouched apart from the expression.
  const rules = await fetchRules();
  const targets = CF_RULE_IDS.map((id) => requireRule(rules, id));
  for (const rule of targets) {
    if (!parseRuleExpression(rule.expression)) {
      throw new Error(
        `Rule ${rule.id} no longer matches the expected shape — refusing to overwrite. Fix it in the dashboard first.`,
      );
    }
  }

  const expression = buildRuleExpression({ ips, keys });
  const token = cfToken();

  // PATCH each rule with the new expression but its OWN other fields. We've
  // already validated all targets above, so a mid-loop failure is rare; if it
  // happens the rules briefly diverge — the error names which one, retry fixes
  // it. ponytail: sequential + no rollback; add a two-phase commit only if a
  // partial update ever actually bites.
  for (const rule of targets) {
    const { version: _v, last_updated: _lu, ...rest } = rule;
    void _v;
    void _lu;
    const res = await fetch(
      `${CF_API}/zones/${CF_ZONE_ID}/rulesets/${CF_RULESET_ID}/rules/${rule.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...rest, expression }),
      },
    );
    const body = await res.json();
    if (!res.ok) {
      throw new Error(
        cfError(body, `Cloudflare PATCH of rule ${rule.id} failed (HTTP ${res.status})`),
      );
    }
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_whitelist_updated",
    metadata: { ip_count: ips.length, key_count: keys.length, rules: CF_RULE_IDS.length },
  });

  return { ips, keys };
}
