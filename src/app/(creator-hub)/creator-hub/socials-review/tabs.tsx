import { TabChips } from "@/components/ux/period-chips";
import type { CreatorSocialStatus } from "@/lib/backend-api";

const TABS: { key: CreatorSocialStatus; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

/**
 * Status tabs for the Socials Review queue — thin composition over the shared
 * `TabChips` (the canonical URL-driven chip selector), so status switches get
 * the house affordances for free: `router.replace(..., { scroll: false })`,
 * the in-chip pending spinner, and the dim-the-others loading state.
 *
 * `activeCount` (when known) renders as a live suffix on the ACTIVE chip only
 * ("Pending · 12") — per-status counts for the other tabs would need extra
 * queries, so they stay plain. The server page streams this in; the Suspense
 * fallback renders the same tabs without the count.
 *
 * Host-awareness: TabChips writes a query-only URL (`?status=…`), which never
 * touches the path — so it works unchanged on the marketing subdomain where
 * the `/creator-hub` prefix is stripped (no `useHostHref` needed).
 *
 * `defaultValue="pending"` keeps the canonical queue at a bare URL. Note:
 * TabChips preserves unrelated params, so a deep `?page=` survives a status
 * switch — the pager clamps/parks gracefully, and page 1 URLs carry no param.
 */
export function SocialsQueueTabs({
  current,
  activeCount,
}: {
  current: CreatorSocialStatus;
  activeCount?: number;
}) {
  const items = TABS.map((tab) => ({
    value: tab.key,
    label:
      tab.key === current && activeCount != null
        ? `${tab.label} · ${activeCount}`
        : tab.label,
  }));

  return (
    <TabChips
      items={items}
      current={current}
      paramKey="status"
      defaultValue="pending"
    />
  );
}
