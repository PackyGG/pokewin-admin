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
// Conventions:
//   - daily_fill is per DAY → weekly raw fill = daily_fill × 7
//   - withdrawal_cap is per WEEK
//   - leaderboard_cost is one-time (the prize pool)
//   - packy_paid_percent is the % we cover of the prize pool
//   - deal_length_weeks scales weekly outflows
//   - tip_balance / battle_balance are flat one-time pots added
//     straight to total (no per-week scaling, no recoup)
//   - video_amount / video_percent / video_fills_per_week — same
//     shape as daily fill but for video deliverables; counts into
//     the same weekly bucket as the withdraw cap (per user spec)
//
// Max Cost = (raw_weekly_fill + weekly_wd_cap + weekly_video_net)
//              × deal_length_weeks
//          + leaderboard_cost × (packy_paid_percent / 100)
//          + tip_balance + battle_balance
//
// where:
//   weekly_video_net = video_amount × video_fills_per_week
//                      × (1 - video_percent / 100)
function maxCost(e: {
  daily_fill_usd: number | null;
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
  const dailyFill = e.daily_fill_usd ?? 0;
  const weeklyRaw = dailyFill * 7;
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
    (weeklyRaw + wdCap + weeklyVideoNet) * weeks +
    rawLb +
    tipBal +
    battleBal
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
        daily_fill_usd:
          e.daily_fill_usd === null ? null : Number(e.daily_fill_usd),
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
  // Weekly burn = sum of (daily_fill × 7 + wd_cap) across all. The
  // "what does this cost us per WEEK" headline number, ignoring deal
  // length and leaderboards.
  const weeklyBurn = estimates.reduce((sum, e) => {
    const weekly =
      (e.daily_fill_usd === null ? 0 : Number(e.daily_fill_usd)) * 7 +
      (e.withdrawal_cap_usd === null ? 0 : Number(e.withdrawal_cap_usd));
    return sum + weekly;
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
          sub="Fills + wd caps / week"
          accent="amber"
        />
      </div>

      <FadeIn>
        <CreatorEstimatesClient estimates={numericEstimates} />
      </FadeIn>
    </div>
  );
}
