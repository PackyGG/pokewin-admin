import Link from "next/link";
import {
  ChevronRight,
  Users,
  Gift,
  TrendingUp,
  Calculator,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Creator Hub dashboard — quick-tools button row (mockup top strip).
 *
 * Four tool shortcuts: My Creators · Tips & Sponsors · Profitability ·
 * ROI Calculator. All link to live routes. Pure presentational, server-safe.
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
    label: "Tips & Sponsors",
    sub: "house-funded giveaways",
    href: "/creator-hub/tips-sponsors",
    icon: Gift,
    tint: "bg-rose-500/15",
    iconColor: "text-rose-500",
  },
  {
    label: "Profitability",
    sub: "deal economics",
    href: "/creator-hub/profitability",
    icon: TrendingUp,
    tint: "bg-pink-500/15",
    iconColor: "text-pink-500",
  },
  {
    label: "ROI Calculator",
    sub: "deal modeling",
    href: "/creator-hub/profitable-algo",
    icon: Calculator,
    tint: "bg-emerald-500/15",
    iconColor: "text-emerald-500",
  },
];

export function HubQuickTools() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {TOOLS.map((tool) => {
        const Icon = tool.icon;
        return (
          <Link
            key={tool.label}
            href={tool.href}
            className={cn(
              "group flex items-center gap-3 rounded-2xl border bg-card p-3.5 outline-none transition-colors",
              "hover:border-border/80 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
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
                {tool.sub}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/50 transition-transform motion-safe:group-hover:translate-x-0.5" />
          </Link>
        );
      })}
    </div>
  );
}
