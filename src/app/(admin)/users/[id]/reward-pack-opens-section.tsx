"use client";

/**
 * Reward / sign-up pack opens section for the user-detail Rewards tab.
 *
 * Surfaces the PROVENANCE of cards a user received from a reward pack — the
 * welcome/onboarding pack, level-up packs, daily/free packs, etc. A reward
 * pack (`packs.pack_type='reward'`) is an INVENTORY GIVEAWAY: the cards land
 * in `user_inventory` with `source_type='reward'` and there is NO ledger grant
 * row, so without this section an admin only sees the later card SALES and
 * cannot tell where the cards came from.
 *
 * READABILITY REDESIGN (owner: "the Rewards tab is hard to read"):
 *   • The old layout drew ONE full panel PER OPEN with a full card list — for a
 *     daily-pack user that is dozens of near-identical walls of cards.
 *   • Now the opens are GROUPED by reward type (welcome pack, each level pack,
 *     daily pack, …) into one scannable box PER TYPE showing that type's
 *     stats (opens / cards / value). Daily packs get a dedicated highlight up
 *     top (how often claimed + how much pulled). The detailed per-card
 *     provenance is PRESERVED but demoted into a collapsible inside each type
 *     box, so "where did these cards come from" is never lost — just secondary.
 *   • PRESENTATION PASS 2 (owner, 2026-07-12: "u didnt update the rewards &
 *     sign up pack opens boxes"): each per-type box mirrors the redesign
 *     already shipped for the Insights → Rewards → Daily Packs breakdown row
 *     (`insights/rewards/_components/daily-pack-row.tsx`) — a small pack
 *     thumbnail (the group's most-recently-opened pack's `packs.image_url`)
 *     next to the compact per-type stat boxes, and the old full-width
 *     "Show per-card detail · N cards across M opens" trigger bar shrunk down
 *     to a small chevron icon-button in the box header (same lazy collapsible
 *     content underneath — no data/functionality change, presentation only).
 *
 * House-POV (CLAUDE.md): a reward-pack grant is the house GIVING the user
 * value → a house COST → card values render in ROSE.
 *
 * Streamed-band contract: receives `Promise<SafeQueryResult<…>> | null`.
 *   • null      → query not kicked for the active tab → skeleton.
 *   • r.error   → visible band error (load failure ≠ empty).
 *   • 0 opens   → self-hides (renders nothing) so the tab stays clean.
 */

import { use, useState } from "react";
import {
  Gift,
  Package,
  Sparkles,
  CalendarDays,
  ChevronDown,
} from "lucide-react";
// Local FLAT primitives (see rewards-summary-section.tsx for why) — not the
// colorful gradient/corner-glow `SectionHeading`/`StatPanel` in the shared
// `@/components/modern-panels`. `AccentColor` is a type-only import from
// there since the local fork doesn't export its own named accent type.
import type { AccentColor } from "@/components/modern-panels";
import { SectionHeading, StatPanel } from "./user-view-modern-panels";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardImage } from "@/components/card-image";
import { InlineError } from "@/components/entity-surface/inline-error";
import { SkeletonCard } from "@/components/ux";
import { RelativeTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { MiniStat, PayoutTile } from "./rewards-summary-section";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type {
  UserRewardPackOpensResult,
  RewardPackOpenEntry,
} from "@/lib/queries/users-reward-pack-opens";

const ROSE = "text-rose-600 dark:text-rose-400";

const RARITY_COLORS: Record<string, string> = {
  common: "bg-zinc-700/90 text-zinc-100",
  uncommon: "bg-emerald-700/90 text-emerald-100",
  rare: "bg-blue-700/90 text-blue-100",
  "ultra rare": "bg-purple-700/90 text-purple-100",
  "secret rare": "bg-yellow-600/90 text-yellow-100",
  legendary: "bg-orange-600/90 text-orange-100",
  holo: "bg-cyan-700/90 text-cyan-100",
  secret: "bg-pink-700/90 text-pink-100",
};

// Accent per reward cadence so the boxes read as a family but stay
// distinguishable: daily = cyan (recurring), one-time = purple (welcome/level),
// balance = amber, unknown/unresolved = purple.
const TYPE_ACCENT: Record<string, AccentColor> = {
  daily: "cyan",
  one_time: "purple",
  balance: "amber",
};

/** One reward-TYPE group: all opens of the same reward (e.g. every daily-pack
 *  open) folded into one scannable box. */
type RewardTypeGroup = {
  key: string;
  typeName: string;
  rewardType: string | null;
  rewardSlug: string | null;
  opensCount: number;
  cardCount: number;
  ownedCount: number;
  totalValue: number;
  opens: RewardPackOpenEntry[];
};

function groupByRewardType(opens: RewardPackOpenEntry[]): RewardTypeGroup[] {
  const groups = new Map<string, RewardTypeGroup>();
  for (const open of opens) {
    // Stable grouping key: the reward program (slug) first; fall back to name,
    // then pack name, then a single "unresolved" bucket for legacy rows.
    const key =
      open.rewardSlug ?? open.rewardName ?? open.packName ?? "__unresolved__";
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        typeName: open.rewardName ?? open.packName ?? "Reward pack",
        rewardType: open.rewardType,
        rewardSlug: open.rewardSlug,
        opensCount: 0,
        cardCount: 0,
        ownedCount: 0,
        totalValue: 0,
        opens: [],
      };
      groups.set(key, g);
    }
    g.opensCount += 1;
    g.cardCount += open.cardCount;
    g.ownedCount += open.ownedCount;
    g.totalValue += open.totalValue;
    g.opens.push(open);
  }
  // Biggest house cost first — matches the "these are giveaways / cost" framing.
  return [...groups.values()].sort((a, b) => b.totalValue - a.totalValue);
}

export function RewardPackOpensSection({
  rewardPackOpensPromise,
}: {
  rewardPackOpensPromise: Promise<
    SafeQueryResult<UserRewardPackOpensResult>
  > | null;
}) {
  if (!rewardPackOpensPromise) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Gift} title="Reward & sign-up pack opens" />
        <SkeletonCard lines={4} />
      </div>
    );
  }
  return (
    <RewardPackOpensStreamed rewardPackOpensPromise={rewardPackOpensPromise} />
  );
}

function RewardPackOpensStreamed({
  rewardPackOpensPromise,
}: {
  rewardPackOpensPromise: Promise<SafeQueryResult<UserRewardPackOpensResult>>;
}) {
  const r = use(rewardPackOpensPromise);

  if (r.error) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={Gift} title="Reward & sign-up pack opens" />
        <InlineError
          compact
          title="Couldn't load reward pack opens"
          hint="This is a load failure, not an empty history — retry to re-run the query."
        />
      </div>
    );
  }

  const result = r.data;

  // Self-hide when the user never received a card from a reward pack — keeps
  // the Rewards tab focused for the common case.
  if (result.totalOpens === 0) return null;

  const groups = groupByRewardType(result.opens);

  // Daily-packs highlight (owner item 2): how often claimed + how much pulled.
  const dailyGroups = groups.filter((g) => g.rewardType === "daily");
  const dailyOpens = dailyGroups.reduce((s, g) => s + g.opensCount, 0);
  const dailyCards = dailyGroups.reduce((s, g) => s + g.cardCount, 0);
  const dailyValue = dailyGroups.reduce((s, g) => s + g.totalValue, 0);

  return (
    <div className="space-y-3">
      <SectionHeading icon={Gift} title="Reward & sign-up pack opens" />
      <p className="-mt-1 text-[11px] text-muted-foreground">
        Cards this user received from a{" "}
        <span className="font-medium text-foreground">reward pack</span> — the
        sign-up / welcome pack, level packs and daily / free packs. These are
        granted straight into inventory (no purchase), so they don&apos;t show
        in the ledger except when the card is later sold. Amounts are the
        house&apos;s cost of the giveaway.
      </p>

      {/* Totals strip — opens, cards granted, total house cost (rose, but
          zero-aware: a genuine $0.00 grant value is neutral, not a cost). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <PayoutTile
          label="Reward packs opened"
          value={formatNumber(result.totalOpens)}
          icon={Package}
          accent="purple"
        />
        <PayoutTile
          label="Cards granted"
          value={formatNumber(result.totalCards)}
          icon={Gift}
          accent="purple"
        />
        <PayoutTile
          label="Value granted"
          value={formatCurrency(result.totalValue)}
          icon={Sparkles}
          accent={result.totalValue > 0 ? "rose" : "blue"}
        />
      </div>

      {/* Daily-packs highlight — only when the user actually claimed daily
          packs. "How often" (opens) + "how much pulled" (value). */}
      {dailyOpens > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <PayoutTile
            label="Daily packs claimed"
            value={formatNumber(dailyOpens)}
            sub={dailyOpens === 1 ? "time" : "times"}
            icon={CalendarDays}
            accent="cyan"
          />
          <PayoutTile
            label="Daily-pack cards"
            value={formatNumber(dailyCards)}
            sub="granted"
            icon={Gift}
            accent="cyan"
          />
          <PayoutTile
            label="Daily-pack value"
            value={formatCurrency(dailyValue)}
            sub="pulled"
            icon={Sparkles}
            accent={dailyValue > 0 ? "rose" : "blue"}
          />
        </div>
      ) : null}

      {/* One box PER reward type — scannable stats, per-card detail collapsed. */}
      <div className="space-y-3">
        {groups.map((g) => (
          <RewardTypeBox key={g.key} group={g} />
        ))}
      </div>
    </div>
  );
}

function RewardTypeBox({ group }: { group: RewardTypeGroup }) {
  const [open, setOpen] = useState(false);
  const accent: AccentColor =
    (group.rewardType && TYPE_ACCENT[group.rewardType]) || "purple";
  // Representative pack thumbnail for the whole type group — the most
  // recently opened pack's image (opens are newest-first, so `opens[0]` is
  // it). Same `CardImage` + `packs.image_url` source /packs and the Daily
  // Packs breakdown row use; `CardImage` already falls back to a neutral
  // placeholder icon when the URL is null/broken, so unresolved legacy opens
  // just render blank instead of a fabricated image.
  const imageUrl = group.opens[0]?.packImageUrl ?? null;
  const detailLabel = `${formatNumber(group.cardCount)} ${
    group.cardCount === 1 ? "card" : "cards"
  } across ${formatNumber(group.opensCount)} ${
    group.opensCount === 1 ? "open" : "opens"
  }`;

  return (
    // Collapsible wraps the whole box so the trigger can live in the header
    // (next to the type badge) while the content stays below the stat row —
    // mirrors the Daily Packs breakdown row's toggle-next-to-value placement.
    <Collapsible open={open} onOpenChange={setOpen}>
      <StatPanel
        title={group.typeName}
        icon={Package}
        accent={accent}
        action={
          <div className="flex shrink-0 items-center gap-1.5">
            {group.rewardType ? (
              <Badge variant="outline" className="text-[10px] capitalize">
                {group.rewardType.replace(/_/g, " ")}
              </Badge>
            ) : null}
            {/* Small icon-button toggle — replaces the old full-width "show
                per-card detail" bar (owner: mirror the Daily Packs row's
                compact trigger). Reveals the same per-card provenance,
                collapsed by default. */}
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={
                    open
                      ? `Hide per-card detail for ${group.typeName}`
                      : `Show per-card detail for ${group.typeName} — ${detailLabel}`
                  }
                  title={open ? "Hide per-card detail" : `Show per-card detail · ${detailLabel}`}
                />
              }
            >
              <ChevronDown
                className={cn(
                  "size-3.5 motion-safe:transition-transform motion-safe:duration-200",
                  open && "rotate-180",
                )}
              />
            </CollapsibleTrigger>
          </div>
        }
      >
        {/* Pack thumbnail + scannable per-type stats, side by side — mirrors
            the Daily Packs breakdown row (image left, compact stat boxes
            next to it). */}
        <div className="flex items-start gap-2.5">
          <div className="relative size-10 shrink-0 overflow-hidden rounded-lg bg-muted/40 ring-1 ring-border">
            <CardImage
              src={imageUrl}
              alt={group.typeName}
              className="absolute inset-0 size-full"
            />
          </div>
          <div className="grid min-w-0 flex-1 grid-cols-3 gap-2">
            <MiniStat
              label={group.rewardType === "daily" ? "Claims" : "Opens"}
              value={formatNumber(group.opensCount)}
              sub={group.rewardType === "daily" ? "daily" : "reward pack"}
            />
            <MiniStat
              label="Cards"
              value={formatNumber(group.cardCount)}
              sub={
                group.ownedCount > 0
                  ? `${formatNumber(group.ownedCount)} still held`
                  : "all sold / exchanged"
              }
            />
            <MiniStat
              label="Value"
              value={formatCurrency(group.totalValue)}
              valueClassName={ROSE}
              sub="house cost"
            />
          </div>
        </div>

        {/* Per-card provenance — PRESERVED but secondary, revealed by the
            small chevron button in the header above (collapsed by default). */}
        <CollapsibleContent className="mt-3 space-y-2.5">
          {group.opens.map((o) => (
            <RewardPackOpenDetail key={o.sessionId ?? "unresolved"} open={o} />
          ))}
        </CollapsibleContent>
      </StatPanel>
    </Collapsible>
  );
}

/** One open's detail — the reward it came from + the cards it produced. Lives
 *  inside the per-type collapsible (secondary provenance view). */
function RewardPackOpenDetail({ open }: { open: RewardPackOpenEntry }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground">
          {open.packName ?? "Reward pack"}
        </span>
        {open.rewardName ? (
          <Badge
            variant="outline"
            className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30 text-[10px]"
          >
            {open.rewardName}
          </Badge>
        ) : null}
        {open.openedAt ? (
          <span className="text-[11px] text-muted-foreground">
            opened <RelativeTime date={open.openedAt} />
          </span>
        ) : null}
        <span className="ml-auto flex items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Granted
          </span>
          {/* House-POV: a reward-pack grant is a house cost → rose. */}
          <span className={cn("text-sm font-bold tabular-nums", ROSE)}>
            {formatCurrency(open.totalValue)}
          </span>
        </span>
      </div>

      <ul className="space-y-1">
        {open.cards.map((card) => (
          <li
            key={card.inventoryId}
            className="flex items-center justify-between gap-2 rounded-md border bg-background/60 px-2.5 py-1.5 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              {card.rarity ? (
                <span
                  className={cn(
                    "shrink-0 rounded px-1 py-0.5 text-[10px] font-semibold uppercase leading-none",
                    RARITY_COLORS[card.rarity.toLowerCase()] ??
                      "bg-black/80 text-white",
                  )}
                >
                  {card.rarity}
                </span>
              ) : null}
              <span className="truncate" title={card.cardName}>
                {card.cardName}
              </span>
              {!card.owned ? (
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
                  sold
                </span>
              ) : null}
            </span>
            {/* House-POV: card value granted to the user → house cost → rose. */}
            <span className={cn("shrink-0 font-semibold tabular-nums", ROSE)}>
              {formatCurrency(card.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
