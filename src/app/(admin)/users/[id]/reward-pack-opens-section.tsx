"use client";

/**
 * Reward / sign-up pack opens section for the user-detail Rewards tab.
 *
 * Surfaces the PROVENANCE of cards a user received from a reward pack — the
 * welcome/onboarding pack, level-up packs, daily/free packs, etc. A reward
 * pack (`packs.pack_type='reward'`) is an INVENTORY GIVEAWAY: the cards land
 * in `user_inventory` with `source_type='reward'` and there is NO ledger grant
 * row, so without this section an admin only sees the later card SALES and
 * cannot tell where the cards came from. This is the owner's primary ask:
 * "sign-up packs are rewards → show it in the Rewards tab".
 *
 * House-POV (CLAUDE.md): a reward-pack grant is the house GIVING the user
 * value → a house COST → card values render in ROSE, consistent with every
 * other reward cost on the site.
 *
 * Streamed-band contract: receives `Promise<SafeQueryResult<…>> | null`.
 *   • null      → query not kicked for the active tab → skeleton.
 *   • r.error   → visible amber band error (load failure ≠ empty).
 *   • 0 opens   → self-hides (renders nothing) so the tab stays clean for
 *                 users who never got a reward pack.
 */

import { use } from "react";
import { Gift, Package, Sparkles } from "lucide-react";
import { SectionHeading, StatPanel, KpiTile } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
import { InlineError } from "@/components/entity-surface/inline-error";
import { SkeletonCard } from "@/components/ux";
import { RelativeTime } from "@/components/relative-time";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { SafeQueryResult } from "@/lib/errors/safe-query";
import type {
  UserRewardPackOpensResult,
  RewardPackOpenEntry,
} from "@/lib/queries/users-reward-pack-opens";

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
    <RewardPackOpensStreamed
      rewardPackOpensPromise={rewardPackOpensPromise}
    />
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

      {/* Totals strip — opens, cards granted, total house cost (rose). */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiTile
          label="Reward packs opened"
          value={formatNumber(result.totalOpens)}
          icon={Package}
          accent="purple"
        />
        <KpiTile
          label="Cards granted"
          value={formatNumber(result.totalCards)}
          icon={Gift}
          accent="purple"
        />
        <KpiTile
          label="Value granted"
          value={formatCurrency(result.totalValue)}
          icon={Sparkles}
          accent="rose"
        />
      </div>

      {/* Per-open detail — each reward pack open, the reward that granted it,
          and the cards it produced. */}
      <div className="space-y-3">
        {result.opens.map((open) => (
          <RewardPackOpenCardPanel key={open.sessionId ?? "unresolved"} open={open} />
        ))}
      </div>
    </div>
  );
}

function RewardPackOpenCardPanel({ open }: { open: RewardPackOpenEntry }) {
  const title = open.packName ?? "Reward pack";
  return (
    <StatPanel title={title} icon={Package} accent="purple">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {open.rewardName ? (
          <Badge
            variant="outline"
            className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
          >
            {open.rewardName}
          </Badge>
        ) : null}
        {open.rewardType ? (
          <Badge variant="outline" className="text-[10px] capitalize">
            {open.rewardType.replace(/_/g, " ")}
          </Badge>
        ) : null}
        {open.openedAt ? (
          <span className="text-[11px] text-muted-foreground">
            opened <RelativeTime date={open.openedAt} />
          </span>
        ) : null}
        <span className="ml-auto flex items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Granted value
          </span>
          {/* House-POV: a reward-pack grant is a house cost → rose. */}
          <span className="text-base font-bold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(open.totalValue)}
          </span>
        </span>
      </div>

      <div className="mb-2 text-[11px] text-muted-foreground">
        {formatNumber(open.cardCount)}{" "}
        {open.cardCount === 1 ? "card" : "cards"} granted
        {open.ownedCount > 0 ? (
          <> · {formatNumber(open.ownedCount)} still held</>
        ) : (
          <> · all sold or exchanged</>
        )}
      </div>

      <ul className="space-y-1">
        {open.cards.map((card) => (
          <li
            key={card.inventoryId}
            className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-2.5 py-1.5 text-sm"
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
            <span className="shrink-0 font-semibold tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(card.value)}
            </span>
          </li>
        ))}
      </ul>
    </StatPanel>
  );
}
