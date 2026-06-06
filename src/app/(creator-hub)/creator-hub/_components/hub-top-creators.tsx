import Link from "next/link";
import { Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCompactUsd } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { type HubTopCreator } from "../_queries/dashboard-overview";

/**
 * Creator Hub dashboard — Top Creators ranked list (left/hero element of
 * the 3-up row). Best-performing creators over the active window, ranked
 * by windowed affiliate wager (wager-desc from the overview query).
 *
 * House-POV: a creator's cohort WAGER is house gain → emerald. Each row
 * links into the Hub creator detail page (`/creator-hub/creators/[id]`) so the
 * manager can drill in. Server-safe (data passed in, no function props).
 *
 * Empty state: when the window has no attributed activity (or the GGR
 * read degraded), shows a clean "no creator activity in this window"
 * message rather than a blank card.
 */

// Avatar fallback tints, cycled by rank so the list reads colorfully like
// the mockup (decorative only — not a house-POV signal).
const RANK_TINTS = [
  "bg-pink-500/15 text-pink-700 dark:text-pink-300",
  "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
];

function initials(name: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}

export function HubTopCreators({
  creators,
}: {
  creators: HubTopCreator[];
}) {
  if (creators.length === 0) {
    return (
      <div className="flex h-full min-h-[180px] flex-col items-center justify-center gap-2 rounded-md border border-dashed py-8 text-center">
        <Users className="size-5 text-muted-foreground/60" />
        <p className="text-sm text-muted-foreground">
          No creator activity in this window
        </p>
        <p className="text-xs text-muted-foreground/70">
          Wagers from creator-code cohorts will rank here.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-border/60">
      {creators.map((c, i) => (
        <li key={c.creatorUserId}>
          <Link
            href={`/creator-hub/creators/${c.creatorUserId}`}
            className="flex items-center gap-3 rounded-lg px-1.5 py-2 outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="w-4 shrink-0 text-center text-xs font-bold text-muted-foreground/70 tabular-nums">
              {i + 1}
            </span>
            <Avatar className="size-8 shrink-0">
              {c.image && <AvatarImage src={c.image} alt="" />}
              <AvatarFallback
                className={cn(
                  "text-[11px] font-semibold",
                  RANK_TINTS[i % RANK_TINTS.length],
                )}
              >
                {initials(c.username)}
              </AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {c.username ?? "Unknown"}
              </span>
              <span className="block truncate text-[11px] text-muted-foreground">
                GGR {formatCompactUsd(c.ggrUsd)}
              </span>
            </span>
            <span className="shrink-0 text-right">
              {/* Cohort wager = house gain → emerald (house-POV). */}
              <span className="block text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCompactUsd(c.wagerUsd)}
              </span>
              <span className="block text-[10px] text-muted-foreground">
                wager
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
