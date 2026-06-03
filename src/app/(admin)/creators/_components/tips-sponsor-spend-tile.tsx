import { Gift } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { StatPanel, TILE_COLORS } from "@/components/modern-panels";
import { InfoHint } from "./info-hint";

/**
 * Tips & Sponsor-spend panel for the /creators list KPI strip.
 *
 * A `StatPanel`-style box (spans 2 grid columns on the strip, mirroring the
 * sibling Leaderboard Spend panel) that surfaces how much the HOUSE has
 * spent funding creator-given TIPS + battle SPONSORSHIPS — the separate,
 * house-funded tips/sponsor pool from §3 of the creator model.
 *
 * House-POV: this pool is house-provided, so every dollar a creator hands
 * out from it is a house COST → rose throughout (the combined total is the
 * hero; the two legs are the breakdown rows).
 *
 * Source: lifetime Σ |amount| over the ledger legs `creator_fill_spend_tip`
 * (tips) + `creator_fill_spend_battle` (battle sponsorships), filtered via
 * `type::text` so a not-yet-populated enum value can't error — it just
 * reads $0 until the fill system is live (see `getTipsSponsorSpend`).
 *
 * Server-safe: serializable props only + the string-only <InfoHint> client
 * component, so it renders directly from the server strip (no function
 * props cross the RSC boundary).
 */

const INFO_TEXT =
  "House-funded tips + battle sponsorships creators gave out (creator_fill_spend_tip + creator_fill_spend_battle). $0 until the fill system is live.";

export function TipsSponsorSpendPanel({
  tipSpendUsd,
  sponsorSpendUsd,
  totalUsd,
}: {
  /** Lifetime Σ |amount| over creator_fill_spend_tip (house cost, rose). */
  tipSpendUsd: number | null;
  /** Lifetime Σ |amount| over creator_fill_spend_battle (house cost, rose). */
  sponsorSpendUsd: number | null;
  /** Combined house cost — null when the query failed (box reads "—"). */
  totalUsd: number | null;
}) {
  const rose = TILE_COLORS.rose;

  return (
    <StatPanel
      title="Tips & Sponsor Spend"
      icon={Gift}
      accent="rose"
      action={<InfoHint text={INFO_TEXT} />}
    >
      {/* Hero — combined house cost (rose). */}
      <p
        className={cn(
          "truncate text-2xl font-bold leading-none tracking-tight tabular-nums sm:text-3xl",
          rose.text,
        )}
      >
        {totalUsd != null ? formatCurrency(totalUsd) : "—"}
      </p>
      <p className="mt-1 truncate text-[11px] text-muted-foreground sm:text-xs">
        Total house-funded tips + sponsorships
      </p>

      {/* Per-leg breakdown — tips + battle sponsorships, both rose (house
          cost). Mirrors the secondary-figure block on the sibling
          Leaderboard Spend panel. */}
      <div className="mt-3 space-y-0.5 border-t border-border/50 pt-2">
        <div className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">
            Spent on tips
          </span>
          <span className={cn("shrink-0 font-medium tabular-nums", rose.text)}>
            {tipSpendUsd != null ? formatCurrency(tipSpendUsd) : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 py-1 text-sm">
          <span className="min-w-0 truncate text-muted-foreground">
            Spent on sponsor
          </span>
          <span className={cn("shrink-0 font-medium tabular-nums", rose.text)}>
            {sponsorSpendUsd != null ? formatCurrency(sponsorSpendUsd) : "—"}
          </span>
        </div>
      </div>
    </StatPanel>
  );
}
