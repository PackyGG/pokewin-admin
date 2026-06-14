"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ShieldCheck, KeyRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";
import { ADMINS_ACCESS_TABS, type AdminsAccessTab } from "../tabs";

const TAB_META: Record<
  AdminsAccessTab,
  { label: string; icon: typeof ShieldCheck }
> = {
  admins: { label: "Admins", icon: ShieldCheck },
  roles: { label: "Roles & Permissions", icon: KeyRound },
};

/**
 * Tab strip for /admin-users (the merged Admins & Access surface). URL-driven
 * (?tab=admins | ?tab=roles) so the server can mount ONLY the active tab's
 * segment (Active-Tab-Only — the inactive tab never touches the DB). Same
 * `useTransition` + `router.replace(..., { scroll: false })` + prefetch
 * mechanic as the /insights/analytics tab nav, so switching keeps the current
 * tab's content mounted (dimmed, in-chip spinner) while the next tab streams
 * in instead of blanking to a skeleton.
 *
 * SECURITY: the Roles tab is admin-only. When `isAdmin` is false the Roles
 * chip is not rendered at all, so a non-admin who can view /admin-users (via
 * the page key) never sees a path into roles management. This is a UI gate on
 * top of the real server-side `requireAdmin()` boundary in the Roles segment.
 */
export function AdminsAccessTabNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "admins") as AdminsAccessTab;
  const [isPending, startTransition] = useTransition();

  // Non-admins only get the Admins tab. With a single tab the strip would be
  // pointless chrome, so render nothing for them.
  const tabs = isAdmin
    ? ADMINS_ACCESS_TABS
    : ADMINS_ACCESS_TABS.filter((t) => t !== "roles");
  if (tabs.length < 2) return null;

  function hrefFor(tab: AdminsAccessTab): string {
    const p = new URLSearchParams();
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  function go(tab: AdminsAccessTab) {
    if (tab === current) return;
    startTransition(() => {
      router.replace(hrefFor(tab), { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Admins & Access sections"
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
              // During a pending switch the prior tab keeps its content (the
              // transition holds it); we only dim the OTHER chips so the
              // loading state is legible without blanking anything.
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
