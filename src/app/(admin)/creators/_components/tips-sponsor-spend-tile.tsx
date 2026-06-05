import { Gift } from "lucide-react";

import { InfoHint } from "./info-hint";
import {
  CreatorsKpiPanel,
  CreatorsPlainHero,
  CreatorsPanelChip,
  CreatorsPanelSub,
} from "./creators-kpi-panel";

/**
 * Tips & Sponsor-spend panel for the /creators list KPI strip.
 *
 * Reskinned onto the shared dashboard-style panel (`CreatorsKpiPanel`) so it
 * reads as one family with the rest of the strip: a tinted Card, header (Gift
 * icon + ⓘ hint), a rose HERO, and a 2-chip breakdown row splitting the hero
 * into its tip + battle-sponsorship legs. Surfaces how much the HOUSE has
 * spent funding creator-given TIPS + battle SPONSORSHIPS — the separate,
 * house-funded tips/sponsor pool from §3 of the creator model.
 *
 *   • Total — rose HERO: the combined house cost of the tips/sponsor pool
 *     (what we've funded). Sub-line: "Tips + sponsorships".
 *   • Two chips split the hero into its tip + battle-sponsorship legs.
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
  return (
    <CreatorsKpiPanel
      title="Tips & Sponsor Spend"
      icon={Gift}
      tint="rose"
      titleAdornment={<InfoHint text={INFO_TEXT} />}
    >
      <CreatorsPlainHero
        value={totalUsd}
        format="currency"
        className="text-rose-400"
      />
      <CreatorsPanelSub>Tips + sponsorships</CreatorsPanelSub>
      {/* The two legs (tips + battle sponsorships), both rose (house cost). */}
      <div className="grid grid-cols-2 gap-1.5 -mx-0.5">
        <CreatorsPanelChip label="Tips" value={tipSpendUsd} tone="rose" />
        <CreatorsPanelChip
          label="Sponsor"
          value={sponsorSpendUsd}
          tone="rose"
        />
      </div>
    </CreatorsKpiPanel>
  );
}
