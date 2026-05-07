import { Calculator, Coins, ListChecks, Users } from "lucide-react";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { ensureCreatorEstimatesSchema } from "@/lib/creator-estimates/ensure-schema";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { CreatorEstimatesClient } from "./list-client";

export const metadata = { title: "Creator Deals · Estimates" };

// Same cadence multiplier the /salaries page uses. Keep in sync.
function periodsPerMonth(cadence: string): number {
  if (cadence === "weekly") return 52 / 12;
  if (cadence === "biweekly") return 26 / 12;
  return 1;
}

// Worst-case monthly spend for a single estimate row, normalized to
// a calendar month. fill_amount net of recoup % + every cap as if
// fully consumed. This is intentionally pessimistic — admins want
// "what's the maximum we'd pay this creator per month" so they can
// budget conservatively.
function maxMonthlySpend(e: {
  cadence: string;
  fill_amount_usd: number | null;
  fill_percent: number | null;
  withdrawal_cap_usd: number | null;
  tip_cap_usd: number | null;
  free_battle_cap_usd: number | null;
}): number {
  const fill = e.fill_amount_usd ?? 0;
  const fillKeep = e.fill_percent ?? 0; // % house keeps
  const fillNet = fill * (1 - fillKeep / 100);
  const wd = e.withdrawal_cap_usd ?? 0;
  const tip = e.tip_cap_usd ?? 0;
  const fb = e.free_battle_cap_usd ?? 0;
  const perPeriod = fillNet + wd + tip + fb;
  return perPeriod * periodsPerMonth(e.cadence);
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
    cadence: (["weekly", "biweekly", "monthly"].includes(e.cadence)
      ? e.cadence
      : "monthly") as "weekly" | "biweekly" | "monthly",
    fillAmountUsd: e.fill_amount_usd === null ? null : Number(e.fill_amount_usd),
    fillPercent: e.fill_percent === null ? null : Number(e.fill_percent),
    withdrawalCapUsd:
      e.withdrawal_cap_usd === null ? null : Number(e.withdrawal_cap_usd),
    withdrawalPercent:
      e.withdrawal_percent === null ? null : Number(e.withdrawal_percent),
    tipCapUsd: e.tip_cap_usd === null ? null : Number(e.tip_cap_usd),
    freeBattleCapUsd:
      e.free_battle_cap_usd === null ? null : Number(e.free_battle_cap_usd),
    notes: e.notes,
    createdAt: e.created_at.toISOString(),
  }));

  // Aggregate KPIs (worst-case monthly spend across all entries).
  const totalMonthlySpend = estimates.reduce(
    (sum, e) =>
      sum +
      maxMonthlySpend({
        cadence: e.cadence,
        fill_amount_usd:
          e.fill_amount_usd === null ? null : Number(e.fill_amount_usd),
        fill_percent: e.fill_percent === null ? null : Number(e.fill_percent),
        withdrawal_cap_usd:
          e.withdrawal_cap_usd === null
            ? null
            : Number(e.withdrawal_cap_usd),
        tip_cap_usd: e.tip_cap_usd === null ? null : Number(e.tip_cap_usd),
        free_battle_cap_usd:
          e.free_battle_cap_usd === null
            ? null
            : Number(e.free_battle_cap_usd),
      }),
    0,
  );
  const totalFillsMonthly = estimates.reduce((sum, e) => {
    const fill = e.fill_amount_usd === null ? 0 : Number(e.fill_amount_usd);
    return sum + fill * periodsPerMonth(e.cadence);
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
              see what they&apos;d cost monthly. Not linked to any
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
        {/* Monthly spend = sum of every entry's max monthly spend.
            Rose because it's house outflow (CLAUDE.md: paying out
            to creators = house loss). */}
        <KpiTile
          label="Max Monthly Spend"
          value={`$${totalMonthlySpend.toLocaleString(undefined, {
            maximumFractionDigits: 0,
          })}`}
          icon={Calculator}
          sub="Worst-case across all"
          accent="rose"
        />
        <KpiTile
          label="Monthly Fills"
          value={`$${totalFillsMonthly.toLocaleString(undefined, {
            maximumFractionDigits: 0,
          })}`}
          icon={Coins}
          sub="Gross, before recoup"
          accent="amber"
        />
      </div>

      <FadeIn>
        <CreatorEstimatesClient estimates={numericEstimates} />
      </FadeIn>
    </div>
  );
}
