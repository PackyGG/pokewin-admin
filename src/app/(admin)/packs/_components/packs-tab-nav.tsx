"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Package, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";
import { PACKS_TABS, type PacksTab } from "../tabs";

const TAB_META: Record<PacksTab, { label: string; icon: typeof Package }> = {
  catalog: { label: "Catalog", icon: Package },
  transactions: { label: "Transactions", icon: Receipt },
};

/**
 * Tab strip for /packs (the merged Catalog + Transactions surface). URL-driven
 * (?tab=catalog | ?tab=transactions) so the server mounts ONLY the active tab's
 * segment (Active-Tab-Only — the inactive tab never runs its queries). Same
 * `useTransition` + `router.replace(..., { scroll: false })` + prefetch mechanic
 * as the /admin-users tab nav, so switching keeps the current tab's content
 * mounted (dimmed, in-chip spinner) while the next tab streams in.
 *
 * SECURITY: the Transactions chip is gated by `canViewTransactions`, which the
 * server derives from `pageAccessGranted(allowed_pages, "/transactions/packs")`.
 * A user with Catalog access but NOT pack-transactions access never sees a path
 * into the transactions view, and the page's per-tab `requirePageAccess`
 * boundary enforces it server-side regardless of the URL.
 */
export function PacksTabNav({
  canViewTransactions,
}: {
  canViewTransactions: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "catalog") as PacksTab;
  const [isPending, startTransition] = useTransition();

  const tabs = canViewTransactions
    ? PACKS_TABS
    : PACKS_TABS.filter((t) => t !== "transactions");
  // With a single visible tab the strip is pointless chrome.
  if (tabs.length < 2) return null;

  function hrefFor(tab: PacksTab): string {
    // Switching tabs resets the per-tab query params (page/search/sort/filter)
    // — the catalog and transactions surfaces share no param vocabulary, so
    // carrying one tab's params into the other would land mid-data.
    const p = new URLSearchParams();
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  function go(tab: PacksTab) {
    if (tab === current) return;
    startTransition(() => {
      router.replace(hrefFor(tab), { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Packs sections"
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {tabs.map((value) => {
        const { label, icon: Icon } = TAB_META[value];
        const active = current === value;
        return (
          <button
            key={value}
            type="button"
            role="tab"
            onClick={() => go(value)}
            onMouseEnter={() => router.prefetch(hrefFor(value))}
            onFocus={() => router.prefetch(hrefFor(value))}
            disabled={active}
            aria-selected={active}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 scroll-mx-4 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
              isPending && !active && "opacity-50",
            )}
          >
            {active && isPending ? (
              <Spinner size={14} label={`Loading ${label}`} />
            ) : (
              <Icon className="size-3.5" />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}
