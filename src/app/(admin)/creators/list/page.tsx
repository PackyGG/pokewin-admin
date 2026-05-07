import { Calculator, Coins, ListChecks, Users } from "lucide-react";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { ensureCreatorEstimatesSchema } from "@/lib/creator-estimates/ensure-schema";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency } from "@/lib/utils/format";
import { CreatorEstimatesClient } from "./list-client";

export const metadata = { title: "Creator Deals · Estimates" };

// Compute the Max Cost for one estimate row.
//
// Conventions (per user clarification 2026-05-07):
//   - daily_fill is per DAY but is NOT a direct outflow. The fill
//     goes onto the creator's on-site balance and can only LEAVE
//     the platform via withdrawals, which are bounded by
//     withdrawal_cap_usd per week. So the realistic worst-case
//     cost of the fill stream IS wd_cap × weeks, not
//     (daily × 7 + wd_cap) × weeks.
//   - withdrawal_cap is the per-WEEK ceiling on what the creator
//     can withdraw — this is what the house actually pays out for
//     the fill side of the deal.
//   - withdrawal_percent is % of BALANCE (not wager) — informational
//     only, doesn't enter the cost math.
//   - leaderboard_cost is one-time (the prize pool)
//   - packy_paid_percent is the % we cover of the prize pool
//   - deal_length_weeks scales weekly outflows
//   - tip_balance / battle_balance are flat one-time pots added
//     straight to total (no per-week scaling, no recoup)
//   - video_amount / video_percent / video_fills_per_week — paid
//     OUT to the creator separately for video deliverables, with
//     the % we recoup. Net cost adds to the weekly bucket
//     alongside wd_cap.
//
// Max Cost = (weekly_wd_cap + weekly_video_net) × deal_length_weeks
//          + leaderboard_cost × (packy_paid_percent / 100)
//          + tip_balance + battle_balance
//
// where:
//   weekly_video_net = video_amount × video_fills_per_week
//                      × (1 - video_percent / 100)
function maxCost(e: {
  withdrawal_cap_usd: number | null;
  leaderboard_cost_usd: number | null;
  packy_paid_percent: number | null;
  deal_length_weeks: number | null;
  video_amount_usd: number | null;
  video_percent: number | null;
  video_fills_per_week: number | null;
  tip_balance_usd: number | null;
  battle_balance_usd: number | null;
}): number {
  const wdCap = e.withdrawal_cap_usd ?? 0;
  const lbCost = e.leaderboard_cost_usd ?? 0;
  const lbShare = e.packy_paid_percent ?? 0;
  const rawLb = lbCost * (lbShare / 100);
  const weeks = e.deal_length_weeks ?? 0;
  const videoAmt = e.video_amount_usd ?? 0;
  const videoPct = e.video_percent ?? 0;
  const videoFills = e.video_fills_per_week ?? 0;
  const weeklyVideoNet = videoAmt * videoFills * (1 - videoPct / 100);
  const tipBal = e.tip_balance_usd ?? 0;
  const battleBal = e.battle_balance_usd ?? 0;
  return (
    (wdCap + weeklyVideoNet) * weeks + rawLb + tipBal + battleBal
  );
}

export default async function CreatorEstimatesPage() {
  await requirePageAccess("/creators/list");
  // Defensive: if the migration hasn't run, self-heal so the page
  // works on first load. Same pattern /salaries uses.
  await ensureCreatorEstimatesSchema().catch(() => {});

  const estimates = await adminDb.creator_deal_estimates.findMany({
    orderBy: { created_at: "desc" },
  });

  const numericEstimates = estimates.map((e) => ({
    id: e.id,
    name: e.name,
    dailyFillUsd: e.daily_fill_usd === null ? null : Number(e.daily_fill_usd),
    withdrawalCapUsd:
      e.withdrawal_cap_usd === null ? null : Number(e.withdrawal_cap_usd),
    withdrawalPercent:
      e.withdrawal_percent === null ? null : Number(e.withdrawal_percent),
    leaderboardCostUsd:
      e.leaderboard_cost_usd === null ? null : Number(e.leaderboard_cost_usd),
    packyPaidPercent:
      e.packy_paid_percent === null ? null : Number(e.packy_paid_percent),
    dealLengthWeeks:
      e.deal_length_weeks === null ? null : Number(e.deal_length_weeks),
    videoAmountUsd:
      e.video_amount_usd === null ? null : Number(e.video_amount_usd),
    videoPercent:
      e.video_percent === null ? null : Number(e.video_percent),
    videoFillsPerWeek:
      e.video_fills_per_week === null
        ? null
        : Number(e.video_fills_per_week),
    tipBalanceUsd:
      e.tip_balance_usd === null ? null : Number(e.tip_balance_usd),
    battleBalanceUsd:
      e.battle_balance_usd === null ? null : Number(e.battle_balance_usd),
    notes: e.notes,
    createdAt: e.created_at.toISOString(),
  }));

  // Aggregate KPIs across all entries.
  const totalMaxCost = estimates.reduce(
    (sum, e) =>
      sum +
      maxCost({
        withdrawal_cap_usd:
          e.withdrawal_cap_usd === null
            ? null
            : Number(e.withdrawal_cap_usd),
        leaderboard_cost_usd:
          e.leaderboard_cost_usd === null
            ? null
            : Number(e.leaderboard_cost_usd),
        packy_paid_percent:
          e.packy_paid_percent === null ? null : Number(e.packy_paid_percent),
        deal_length_weeks:
          e.deal_length_weeks === null ? null : Number(e.deal_length_weeks),
        video_amount_usd:
          e.video_amount_usd === null ? null : Number(e.video_amount_usd),
        video_percent:
          e.video_percent === null ? null : Number(e.video_percent),
        video_fills_per_week:
          e.video_fills_per_week === null
            ? null
            : Number(e.video_fills_per_week),
        tip_balance_usd:
          e.tip_balance_usd === null ? null : Number(e.tip_balance_usd),
        battle_balance_usd:
          e.battle_balance_usd === null
            ? null
            : Number(e.battle_balance_usd),
      }),
    0,
  );
  // Weekly burn = sum of (wd_cap + weekly_video_net) across all.
  // Daily fill is intentionally NOT in here — it sits on the
  // creator's balance and only leaves via withdrawals (which the
  // wd_cap already bounds). Same conviction as the maxCost helper.
  const weeklyBurn = estimates.reduce((sum, e) => {
    const wdCap =
      e.withdrawal_cap_usd === null ? 0 : Number(e.withdrawal_cap_usd);
    const videoAmt =
      e.video_amount_usd === null ? 0 : Number(e.video_amount_usd);
    const videoPct =
      e.video_percent === null ? 0 : Number(e.video_percent);
    const videoFills =
      e.video_fills_per_week === null ? 0 : Number(e.video_fills_per_week);
    const videoNet = videoAmt * videoFills * (1 - videoPct / 100);
    return sum + wdCap + videoNet;
  }, 0);
  const totalCount = estimates.length;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <ListChecks className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">
              Creator Deal Estimates
            </h1>
            <p className="text-sm text-muted-foreground">
              Scratchpad for prospective creator deals. Enter terms,
              see total cost across all deals. Not linked to any
              real account — pure planning data.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiTile
          label="Tracked"
          value={String(totalCount)}
          icon={Users}
          accent="blue"
        />
        {/* Total Max Cost across all entries — every weekly cap fully
            consumed × deal_length_weeks + leaderboards. Rose because
            it's house outflow per CLAUDE.md house POV. */}
        {/* Currency formatted via the shared en-US formatCurrency
            helper so commas/decimals are unambiguous regardless of
            the admin's browser locale. Previously toLocaleString
            with undefined locale produced "$13.775" in EU locales
            which read as "$13.77" to en-US viewers. */}
        <KpiTile
          label="Total Max Cost"
          value={formatCurrency(totalMaxCost)}
          icon={Calculator}
          sub="Worst case across all"
          accent="rose"
        />
        <KpiTile
          label="Weekly Burn"
          value={formatCurrency(weeklyBurn)}
          icon={Coins}
          sub="WD caps + video net / week"
          accent="amber"
        />
      </div>

      <FadeIn>
        <CreatorEstimatesClient estimates={numericEstimates} />
      </FadeIn>
    </div>
  );
}
