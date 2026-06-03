import { Gift } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import { TILE_COLORS } from "@/components/modern-panels";
import { InfoHint } from "./info-hint";

/**
 * Tips & Sponsor-spend tile for the /creators list KPI strip.
 *
 * A COMPACT, single-cell tile (mirrors the <KpiTile> chrome — same border,
 * accent bar, glassy sheen — and the sibling Leaderboard Spend tile) that
 * surfaces how much the HOUSE has spent funding creator-given TIPS + battle
 * SPONSORSHIPS — the separate, house-funded tips/sponsor pool from §3 of the
 * creator model.
 *
 *   • Total — rose HERO: the combined house cost of the tips/sponsor pool
 *     (what we've funded). Sub-line: "Tips + sponsorships".
 *   • Two muted secondary lines split the hero into its tip + battle-
 *     sponsorship legs.
 *
 * House-POV: this pool is house-provided, so every dollar a creator hands
 * out from it is a house COST → rose throughout.
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
    <div
      className={cn(
        "hover-raise group surface-sheen relative overflow-hidden rounded-xl border px-3 py-2.5 sm:px-4 sm:py-3",
        rose.bg,
      )}
    >
      {/* Left accent bar — rose (house cost), matching <KpiTile>. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-current opacity-50 transition-opacity duration-200 group-hover:opacity-80",
          rose.icon,
        )}
      />
      {/* Glassy diagonal sheen — neutral white so it never fights the
          House-POV rose accent. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-white/[0.04] to-transparent"
      />

      {/* Header row — icon + label + the ⓘ hint in the top-right. */}
      <div className="relative flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
          <Gift className={cn("size-3.5 shrink-0 sm:size-4", rose.icon)} />
          <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground sm:text-[11px]">
            Tips &amp; Sponsor Spend
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <InfoHint text={INFO_TEXT} />
        </div>
      </div>

      {/* Hero — combined house cost (rose). */}
      <p
        className={cn(
          "relative mt-1 truncate text-xl font-bold leading-tight tracking-tight tabular-nums sm:text-2xl",
          rose.text,
        )}
      >
        {totalUsd != null ? formatCurrency(totalUsd) : "—"}
      </p>
      <p className="relative mt-0.5 truncate text-[10px] text-muted-foreground sm:text-[11px]">
        Tips + sponsorships
      </p>

      {/* Secondary — the two legs (tips + battle sponsorships), both rose
          (house cost). Mirrors the muted "Past" line on the sibling
          Leaderboard Spend tile. */}
      <p className="relative mt-1 truncate text-[10px] text-muted-foreground sm:text-[11px]">
        Tips:{" "}
        <span className={cn("font-medium tabular-nums", rose.text)}>
          {tipSpendUsd != null ? formatCurrency(tipSpendUsd) : "—"}
        </span>
        {" · "}Sponsor:{" "}
        <span className={cn("font-medium tabular-nums", rose.text)}>
          {sponsorSpendUsd != null ? formatCurrency(sponsorSpendUsd) : "—"}
        </span>
      </p>
    </div>
  );
}
