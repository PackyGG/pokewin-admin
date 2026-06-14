// Client-safe token → { label, kind } resolver for the per-user permission
// editor. Mirrors `describeToken` in settings/roles/roles-overview-data.ts
// (which is server-only), using the same canonical ADMIN_PAGES / CAPABILITIES
// catalogs. Pure + import-light so it can run in a "use client" component.

import { ADMIN_PAGES } from "@/lib/admin-pages";
import { CAPABILITIES } from "@/app/(admin)/settings/roles/permissions-utils";

export type TokenKind = "page" | "capability" | "value";

export type DescribedToken = {
  token: string;
  label: string;
  kind: TokenKind;
  /** Domain group label (page group / capability group / "Other"). */
  group: string;
};

const PAGE_BY_KEY = new Map(ADMIN_PAGES.map((p) => [p.key, p] as const));
const CAP_BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c] as const));

/**
 * Resolve one permission token to its display label + kind + group. Value
 * tokens (`<base>:<value>`, e.g. a balance limit) are labelled verbatim under
 * "Other"; unknown tokens fall back to the raw string under "Other".
 */
export function describeToken(token: string): DescribedToken {
  const page = PAGE_BY_KEY.get(token);
  if (page) return { token, label: page.label, kind: "page", group: page.group };
  const cap = CAP_BY_KEY.get(token);
  if (cap)
    return { token, label: cap.label, kind: "capability", group: cap.group };
  if (token.includes(":"))
    return { token, label: token, kind: "value", group: "Other" };
  return { token, label: token, kind: "capability", group: "Other" };
}
