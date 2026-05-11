import Link from "next/link";
import { Gift, ExternalLink, Twitter, MessageCircle, Link2 } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

import { getGiveawayFeed, getGiveawayTotals } from "./queries";
import type { GiveawayCard } from "./queries";

export const metadata = { title: "Giveaway" };

/**
 * /marketing/giveaway — feed of every balance adjustment tagged as a
 * giveaway, with the source tweet / Discord link captured at write
 * time. Driven by `admin_giveaway_actions` rows that the adjust-balance
 * flow writes when the reason category is "Giveaway".
 *
 * Read-only: there's no "create" surface here. New giveaways flow in
 * by adjusting a user's balance on /users/[id] with reason=Giveaway.
 */
export default async function GiveawayPage() {
  await requirePageAccess("/marketing/giveaway");
  const [cards, totals] = await Promise.all([
    getGiveawayFeed({ limit: 200 }),
    getGiveawayTotals(),
  ]);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-pink-500/10">
            <Gift className="size-5 text-pink-500" />
          </div>
          <div className="min-w-0">
            <h1 className="text-2xl font-bold leading-tight">Giveaway</h1>
            <p className="text-sm text-muted-foreground">
              Every balance adjustment tagged as a giveaway, with a link to
              the tweet or Discord message that advertised it. New entries
              land here automatically when admins adjust a balance with
              reason = &ldquo;Giveaway&rdquo;.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-2">
        <KpiTile
          label="Total Giveaways"
          value={String(totals.count)}
          icon={Gift}
          accent="pink"
        />
        <KpiTile
          label="Total Value (USD)"
          value={formatCurrency(totals.totalUsd)}
          icon={Gift}
          // House POV: every giveaway dollar is real cash leaving the
          // platform → rose. Matches the convention used everywhere else
          // for "money out".
          accent="rose"
        />
      </div>

      <FadeIn>
        {cards.length === 0 ? (
          <div className="rounded-xl border bg-card p-8 text-center text-sm text-muted-foreground">
            No giveaways yet. They appear here as soon as an admin adjusts a
            user&apos;s balance with the &ldquo;Giveaway&rdquo; reason and a
            source URL.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((card) => (
              <GiveawayCardView key={card.id} card={card} />
            ))}
          </div>
        )}
      </FadeIn>
    </div>
  );
}

// Per-card layout. Compact info box: recipient + amount on top, source
// link + reason in the middle, admin + date on the bottom. Designed so
// 20+ fit on a desktop screen without needing a table view.
function GiveawayCardView({ card }: { card: GiveawayCard }) {
  const display =
    card.recipient.username ?? card.recipient.userId.slice(0, 12);
  const initials = display.slice(0, 2).toUpperCase();

  return (
    <div className="group flex flex-col gap-3 rounded-xl border border-border/60 bg-card p-4 transition-colors hover:border-border">
      {/* Top: recipient + amount */}
      <div className="flex items-start justify-between gap-3">
        <Link
          href={`/users/${card.recipient.userId}`}
          className="flex min-w-0 items-center gap-2 hover:underline"
        >
          <Avatar className="size-8 shrink-0">
            {card.recipient.image && (
              <AvatarImage src={card.recipient.image} alt="" />
            )}
            <AvatarFallback className="bg-pink-500/15 text-[10px] font-semibold text-pink-700 dark:text-pink-300">
              {initials}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{display}</div>
            {card.recipient.username && (
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {card.recipient.userId.slice(0, 12)}…
              </div>
            )}
          </div>
        </Link>
        <div className="shrink-0 text-right">
          <div className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(card.amountUsd)}
          </div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Giveaway
          </div>
        </div>
      </div>

      {/* Middle: source link + optional reason */}
      <div className="space-y-1.5">
        <SourceLink
          url={card.sourceUrl}
          sourceType={card.sourceType}
        />
        {card.reason && card.reason.toLowerCase() !== "giveaway" && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {card.reason}
          </p>
        )}
      </div>

      {/* Bottom: admin + timestamp */}
      <div className="flex items-center justify-between gap-2 border-t border-border/40 pt-2 text-[11px] text-muted-foreground">
        <span>
          by <span className="font-medium text-foreground">{card.admin.username}</span>
        </span>
        <span>{formatDateTime(card.createdAt)}</span>
      </div>
    </div>
  );
}

function SourceLink({
  url,
  sourceType,
}: {
  url: string;
  sourceType: "twitter" | "discord" | "other";
}) {
  const Icon =
    sourceType === "twitter"
      ? Twitter
      : sourceType === "discord"
        ? MessageCircle
        : Link2;
  const label =
    sourceType === "twitter"
      ? "Twitter / X"
      : sourceType === "discord"
        ? "Discord"
        : "Source link";
  const cls =
    sourceType === "twitter"
      ? "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/15"
      : sourceType === "discord"
        ? "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/15"
        : "border-muted bg-muted/30 text-muted-foreground hover:bg-muted/50";
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors",
        cls,
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span>{label}</span>
      <ExternalLink className="size-3 shrink-0 opacity-60" />
    </a>
  );
}

