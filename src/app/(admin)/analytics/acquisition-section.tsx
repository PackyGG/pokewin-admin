import {
  ArrowDownToLine,
  LineChart,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { KpiTile, SectionHeading } from "@/components/modern-panels";
import { getAcquisitionTrend } from "@/lib/queries/analytics-acquisition";
import { AcquisitionChart } from "./acquisition-chart";
import {
  toAcquisitionWindow,
  type AnalyticsPeriod,
} from "./types";

const WINDOW_LABELS: Record<"7d" | "30d" | "90d", string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
};

/**
 * Acquisition — who is arriving and who is paying (folded in from the
 * retired /analytics-2 page).
 *
 * FTDs and existing depositors are mutually exclusive per day, so the two
 * series stack conceptually into "distinct depositors that day". Daily
 * buckets stay bounded via `toAcquisitionWindow`: `today` widens to 7d and
 * `all` caps at 90d, and the heading says so when it diverges from the page
 * period rather than silently showing a different window.
 */
export async function AcquisitionSection({
  period,
}: {
  period: AnalyticsPeriod;
}) {
  const window = toAcquisitionWindow(period);
  const result = await getAcquisitionTrend(window);

  if (!result.available) {
    return (
      <TileErrorFallback
        label="Acquisition activity"
        hint="Live data is temporarily unavailable. The next automatic refresh will retry it."
        size="panel"
      />
    );
  }

  const latest = result.points.at(-1) ?? {
    date: "",
    signups: 0,
    ftds: 0,
    existingDepositors: 0,
  };
  const totals = result.points.reduce(
    (sum, point) => ({
      signups: sum.signups + point.signups,
      ftds: sum.ftds + point.ftds,
      existingDepositors: sum.existingDepositors + point.existingDepositors,
    }),
    { signups: 0, ftds: 0, existingDepositors: 0 },
  );

  // Honest label: when the page period can't drive daily buckets 1:1
  // (today/all), say which window the section actually shows.
  const windowNote =
    window === period
      ? WINDOW_LABELS[window]
      : `${WINDOW_LABELS[window]} (daily view is bounded)`;

  return (
    <div className="space-y-3">
      <SectionHeading
        icon={LineChart}
        title="Acquisition"
        action={
          <span className="text-xs text-muted-foreground">
            {windowNote} · UTC · refreshes every 5 minutes
          </span>
        }
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4">
        <KpiTile
          label="Sign-ups"
          value={totals.signups.toLocaleString("en-US")}
          sub={`${latest.signups.toLocaleString("en-US")} today`}
          icon={UserPlus}
          accent="blue"
        />
        <KpiTile
          label="First-time depositors"
          value={totals.ftds.toLocaleString("en-US")}
          sub={`${latest.ftds.toLocaleString("en-US")} today`}
          icon={ArrowDownToLine}
          accent="emerald"
        />
        <KpiTile
          label="Existing depositors"
          value={totals.existingDepositors.toLocaleString("en-US")}
          sub={`${latest.existingDepositors.toLocaleString("en-US")} today`}
          icon={UsersRound}
          accent="purple"
        />
      </div>
      <AcquisitionChart data={result.points} />
    </div>
  );
}
