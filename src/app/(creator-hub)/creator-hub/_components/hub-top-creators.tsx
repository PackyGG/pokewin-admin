import Link from "next/link";
import { Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { type HubTopCreator } from "../_queries/dashboard-overview";

/**
 * Creator Hub dashboard — Top Creators ranked list (mockup-aligned).
 * Ranked by windowed affiliate wager (desc); each row shows code +
 * period sign-ups, with wager as the hero figure on the right.
 */

const RANK_GRADIENTS = [
  "from-pink-500 to-pink-600",
  "from-blue-500 to-blue-600",
  "from-emerald-500 to-emerald-600",
  "from-amber-500 to-amber-600",
  "from-violet-500 to-violet-600",
  "from-cyan-500 to-cyan-600",
];

function initials(name: string | null): string {
  const clean = (name ?? "").trim();
  if (!clean) return "?";
  return clean.slice(0, 2).toUpperCase();
}

export function HubTopCreators({
  creators,
  periodLabel,
}: {
  creators: HubTopCreator[];
  /** Active window label, e.g. "last 24 hours". */
  periodLabel: string;
}) {
  if (creators.length === 0) {
    return (
      <div className="flex min-h-[180px] flex-col items-center justify-center gap-2 rounded-md border border-dashed py-8 text-center">
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
      {creators.map((c, i) => {
        const codeLine = c.code
          ? `code ${c.code}`
          : "no code yet";
        const signupLine = `${formatNumber(c.signups)} signup${c.signups === 1 ? "" : "s"}`;

        return (
          <li key={c.creatorUserId}>
            <Link
              href={`/creator-hub/creators/${c.creatorUserId}`}
              className="flex items-center gap-3 rounded-lg px-1.5 py-2.5 outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="w-4 shrink-0 text-center text-xs font-bold text-muted-foreground/70 tabular-nums">
                {i + 1}
              </span>
              <Avatar className="size-8 shrink-0 rounded-lg">
                {c.image && <AvatarImage src={c.image} alt="" />}
                <AvatarFallback
                  className={cn(
                    "rounded-lg bg-gradient-to-br text-[11px] font-extrabold text-white",
                    RANK_GRADIENTS[i % RANK_GRADIENTS.length],
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
                  {codeLine} · {signupLine}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCompactUsd(c.wagerUsd)}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  wager · {periodLabel}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
