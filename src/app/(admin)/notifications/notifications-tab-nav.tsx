"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Megaphone, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";
import { NOTIFICATION_TABS, type NotificationTab } from "./tabs";

const TAB_META: Record<
  NotificationTab,
  { label: string; icon: typeof Megaphone }
> = {
  announcements: { label: "Announcements", icon: Megaphone },
  direct: { label: "Direct to user", icon: Send },
};

/**
 * Tab strip for /notifications. Same URL-driven mechanic as the /admin-users
 * nav (`?tab=` + `router.replace(..., { scroll: false })` + prefetch), so the
 * inactive tab never fetches and switching keeps the current content mounted
 * while the next streams in.
 */
export function NotificationsTabNav() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = (searchParams.get("tab") ?? "announcements") as NotificationTab;
  const [isPending, startTransition] = useTransition();

  function hrefFor(tab: NotificationTab): string {
    const p = new URLSearchParams();
    p.set("tab", tab);
    return `${pathname}?${p.toString()}`;
  }

  function go(tab: NotificationTab) {
    if (tab === current) return;
    startTransition(() => {
      router.replace(hrefFor(tab), { scroll: false });
    });
  }

  return (
    <div
      role="tablist"
      aria-label="Notification sections"
      className={cn(
        "flex gap-1 overflow-x-auto overscroll-x-contain rounded-lg border bg-muted/50 p-1",
        "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {NOTIFICATION_TABS.map((value) => {
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
