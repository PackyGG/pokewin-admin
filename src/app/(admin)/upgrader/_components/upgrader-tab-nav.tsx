"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Zap, Receipt } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";
import { UPGRADER_TABS, type UpgraderTab } from "../tabs";

const TAB_META: Record<UpgraderTab, { label: string; icon: typeof Zap }> = {
  catalog: { label: "Catalog", icon: Zap },
  transactions: { label: "Transactions", icon: Receipt },
};

/**
 * Tab strip for /upgrader (the merged Catalog + Transactions surface).
 * URL-driven (?tab=catalog | ?tab=transactions) so the server mounts ONLY the
 * active tab's segment (Active-Tab-Only — the inactive tab never runs its
 * queries). Same `useTransition` + `router.replace(..., { scroll: false })` +
 * prefetch mechanic as the /admin-users tab nav.
 *
 * SECURITY: the Transactions chip is gated by `canViewTransactions`, which the
 * server derives from `pageAccessGranted(allowed_pages, "/transactions/upgrader")`.
 * A user with Catalog access but NOT upgrader-transactions access never sees a
 * path into the transactions view, and the page's per-tab `requirePageAccess`
 * boundary enforces it server-side regardless of the URL.
 */
export function UpgraderTabNav({
  canViewTransactions,
}: {
  canViewTransactions: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "catalog") as UpgraderTab;
  const [isPending, startTransition] = useTransition();

  const tabs = canViewTransactions
    ? UPGRADER_TABS
    : UPGRADER_TABS.filter((t) => t !== "transactions");
  if (tabs.length < 2) return null;

  function hrefFor(tab: UpgraderTab): string {
    // Switching tabs resets the per-tab query params — the catalog and
    // transactions surfaces share no param vocabulary.
    const p = new URLSearchParams();
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  function go(tab: UpgraderTab) {
    if (tab === current) return;
    startTransition(() => {
      router.replace(hrefFor(tab), { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Upgrader sections"
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
