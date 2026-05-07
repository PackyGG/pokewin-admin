import Link from "next/link";
import { Activity, Users } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Two-tab pill navigation shared by /creators/[userId]/users and
 * /creators/[userId]/wagers. Each tab is a real Next.js Link so each
 * tab IS its own URL/page — bookmarkable, shareable, browser-back
 * navigates, the works. The currently-active page passes `active` so
 * the matching pill renders with the primary fill.
 *
 * Server-friendly — Link works in RSC, no client state needed.
 */
export function CodeActivityNav({
  userId,
  active,
}: {
  userId: string;
  active: "users" | "wagers";
}) {
  const tabs = [
    {
      key: "users" as const,
      label: "Users on code",
      icon: Users,
      href: `/creators/${userId}/users`,
    },
    {
      key: "wagers" as const,
      label: "Last wagers",
      icon: Activity,
      href: `/creators/${userId}/wagers`,
    },
  ];

  return (
    <div
      role="navigation"
      aria-label="Code activity"
      className="inline-flex items-center gap-1 rounded-xl border bg-card/60 p-1"
    >
      {tabs.map((t) => {
        const Icon = t.icon;
        const isActive = t.key === active;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={isActive ? "page" : undefined}
            prefetch
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            <span>{t.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
