import Link from "next/link";
import {
  ChevronRight,
  Users,
  Trophy,
  Calculator,
  History,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Creator Hub dashboard — quick-tools button row (mockup top strip).
 *
 * Four tool shortcuts: My Creators · Leaderboards · ROI Calculator ·
 * Changelogs. All link to live routes. Pure presentational, server-safe.
 */

type Tool = {
  label: string;
  sub: string;
  href: string;
  icon: LucideIcon;
  /** Tailwind tint for the icon chip (decorative — not house-POV). */
  tint: string;
  iconColor: string;
};

const TOOLS: Tool[] = [
  {
    label: "My Creators",
    sub: "roster & deals",
    href: "/creator-hub/creators",
    icon: Users,
    tint: "bg-blue-500/15",
    iconColor: "text-blue-500",
  },
  {
    label: "Leaderboards",
    sub: "races & prizes",
    href: "/creator-hub/leaderboards",
    icon: Trophy,
    tint: "bg-amber-500/15",
    iconColor: "text-amber-500",
  },
  {
    label: "ROI Calculator",
    sub: "deal modeling",
    href: "/creator-hub/profitable-algo",
    icon: Calculator,
    tint: "bg-emerald-500/15",
    iconColor: "text-emerald-500",
  },
  {
    label: "Changelogs",
    sub: "audit feed",
    href: "/creator-hub/changelog",
    icon: History,
    tint: "bg-pink-500/15",
    iconColor: "text-pink-500",
  },
];

export function HubQuickTools() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {TOOLS.map((tool) => {
        const Icon = tool.icon;
        const isPlaceholder = tool.href === "#";

        const inner = (
          <>
            <span
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-xl",
                tool.tint,
              )}
            >
              <Icon className={cn("size-[18px]", tool.iconColor)} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {tool.label}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                {isPlaceholder ? "Soon" : tool.sub}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform motion-safe:group-hover:translate-x-0.5" />
          </>
        );

        const baseClass = cn(
          "group flex items-center gap-3 rounded-2xl border bg-card p-3.5 outline-none transition-colors",
          "hover:border-border/80 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
        );

        // Placeholder tools render as a non-interactive <div> — NO href and
        // NO onClick (a function prop from this Server Component would crash
        // the RSC render). Real tools render as a <Link>. This keeps the
        // component server-safe (zero function props) while still blocking
        // navigation on the v1 placeholders.
        if (isPlaceholder) {
          return (
            <div
              key={tool.label}
              aria-disabled
              className={cn(baseClass, "cursor-default")}
            >
              {inner}
            </div>
          );
        }
        return (
          <Link key={tool.label} href={tool.href} className={baseClass}>
            {inner}
          </Link>
        );
      })}
    </div>
  );
}
