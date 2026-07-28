import Link from "next/link";
import {
  Coins,
  MessageCircle,
  Users2,
  UserPlus,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";

import type { RosterCreator } from "../_queries/list-roster-creators";
import {
  ChecklistPill,
  CreatorHref,
  DealStatusBadge,
  ExCreatorBadge,
  LiveBadge,
  PLATFORM_META,
  initials,
  signedHouseClass,
} from "./roster-bits";

/**
 * Server-rendered roster card — flat surface on the house radius scale
 * (panel `rounded-xl`, inner stat tiles `rounded-lg`). No glows, no
 * gradients, no hardcoded shadows: the live pulse uses the standard ping
 * idiom, the avatar fallback is neutral, and the social chips are neutral
 * with the platform hue on the glyph only.
 *
 * The onboarding pill renders from the batched roster checklist data on the
 * row itself — no per-card query, no Suspense island.
 */
export function RosterCard({
  creator: c,
  wagerLabel = "Wager",
}: {
  creator: RosterCreator;
  /** "Wager" on active tab; "Lifetime wager" on past tab. */
  wagerLabel?: string;
}) {
  return (
    <Link
      href={CreatorHref(c.id)}
      className={cn(
        "group relative flex h-full flex-col gap-3 rounded-xl border bg-card p-4 outline-none transition-colors",
        "hover:border-border/80 hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <div className="flex items-start gap-3">
        <Avatar className="size-11 shrink-0">
          {c.image && <AvatarImage src={c.image} alt="" />}
          <AvatarFallback className="bg-muted text-sm font-semibold text-muted-foreground">
            {initials(c.username)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-sm font-semibold">
              {c.username ?? "Unknown"}
            </span>
            {c.isPastCreator && <ExCreatorBadge />}
            {c.isLive && <LiveBadge />}
            {!c.isPastCreator && c.checklist && (
              <ChecklistPill progress={c.checklist} className="shrink-0" />
            )}
          </div>
          {c.code ? (
            <span className="mt-0.5 inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              {c.code}
            </span>
          ) : (
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
              No code yet
            </span>
          )}
        </div>
        {!c.isPastCreator && <DealStatusBadge status={c.dealStatus} />}
      </div>

      {c.socials.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {c.socials.map((s) => {
            const meta = PLATFORM_META[s.platform];
            const Icon = meta?.icon ?? MessageCircle;
            return (
              <span
                key={s.id}
                className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                title={`${meta?.label ?? s.platform}: ${s.username}`}
              >
                <Icon className={cn("size-3", meta?.glyphClass)} />
                <span className="max-w-[90px] truncate">{s.username}</span>
              </span>
            );
          })}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <StatCell
          icon={UserPlus}
          label="Sign-ups"
          value={formatNumber(c.signups)}
        />
        <StatCell icon={Wallet} label="FTDs" value={formatNumber(c.ftds)} />
        <StatCell
          icon={Coins}
          label={wagerLabel}
          value={formatCompactUsd(c.windowedWagerUsd)}
          valueClass="text-emerald-600 dark:text-emerald-400"
        />
        <StatCell
          icon={Users2}
          label="GGR"
          value={
            c.windowedGgrUsd != null
              ? formatCompactUsd(c.windowedGgrUsd)
              : "—"
          }
          valueClass={signedHouseClass(c.windowedGgrUsd)}
        />
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-2.5 text-[11px]">
        <span className="flex items-center gap-1 text-muted-foreground">
          PnL
          <span
            className={cn(
              "font-semibold tabular-nums",
              signedHouseClass(c.lifetimePnlUsd),
            )}
          >
            {c.lifetimePnlUsd != null
              ? formatCompactUsd(c.lifetimePnlUsd)
              : "—"}
          </span>
        </span>
        <span className="flex items-center gap-1 text-muted-foreground">
          Deal
          <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {c.dealValue ? formatCompactUsd(c.dealValue.dealValueUsd) : "—"}
          </span>
        </span>
      </div>
    </Link>
  );
}

function StatCell({
  icon: Icon,
  label,
  value,
  valueClass,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-muted/30 px-2.5 py-1.5">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p className={cn("mt-0.5 text-sm font-bold tabular-nums", valueClass)}>
        {value}
      </p>
    </div>
  );
}
