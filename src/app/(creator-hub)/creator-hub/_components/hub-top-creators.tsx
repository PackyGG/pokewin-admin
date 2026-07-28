import Link from "next/link";
import { Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { HubEmptyState } from "./hub-notice";
import { type HubTopCreator } from "../_queries/hub-top-creators-query";

/**
 * Creator Hub dashboard — Top Creators ranked list.
 * Ranked by code-attributed deposits in the active ranking window (desc);
 * each row shows code + period sign-ups, with deposits as the hero figure.
 *
 * Flat standard: neutral `bg-muted` avatar fallback (the old per-rank
 * gradient fills were decorative noise), deposits stay emerald (House-POV:
 * player deposits = house gain).
 */

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
  /** Active ranking window label, e.g. "3d". */
  periodLabel: string;
}) {
  if (creators.length === 0) {
    return (
      <HubEmptyState
        icon={Users}
        title="No creator activity in this window"
        sub="Code-attributed deposits in this window will rank here."
        className="min-h-[180px] py-8"
      />
    );
  }

  return (
    <ul className="divide-y divide-border/60">
      {creators.map((c, i) => {
        const codeLine = c.code ? `code ${c.code}` : "no code yet";
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
                <AvatarFallback className="rounded-lg bg-muted text-[11px] font-extrabold text-muted-foreground">
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
                  {formatCompactUsd(c.depositsUsd)}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  deposits · {periodLabel}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
