import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getSignupOverview } from "@/lib/queries/insights-rewards/signup/overview";
import { getSignupFunnel } from "@/lib/queries/insights-rewards/signup/funnel";
import { getSignupTimeToClaim } from "@/lib/queries/insights-rewards/signup/time-to-claim";
import { getSignupRetention } from "@/lib/queries/insights-rewards/signup/retention";
import { getSignupFirstDeposit } from "@/lib/queries/insights-rewards/signup/first-deposit";
import {
  getSignupSourceBreakdown,
  type SignupSourceRow,
} from "@/lib/queries/insights-rewards/signup/source";
import { getSignupCountryBreakdown } from "@/lib/queries/insights-rewards/signup/country";
import { getSignupHourOfDay } from "@/lib/queries/insights-rewards/signup/hour-of-day";
import { getSignupCohortMatrix } from "@/lib/queries/insights-rewards/signup/cohort-matrix";
import { getSignupDropOff } from "@/lib/queries/insights-rewards/signup/drop-off";
import { getSignupTopRecipients } from "@/lib/queries/insights-rewards/signup/top-recipients";
import { getSignupGeoTimeSeries } from "@/lib/queries/insights-rewards/signup/geo-timeseries";
import { getSignupDaily } from "@/lib/queries/insights-rewards/signup/daily";
import type { RetentionCurveValue } from "@/lib/queries/insights-rewards/signup/retention";
import { settle, unwrap, buildSection } from "../../_export-section";

const AREA = "insights.export.signup";

/**
 * Export gatherer for /insights/rewards/signup.
 *
 * Bundles every tab's data for the active period into one CSV: overview
 * KPIs + daily signup/claim/cost series, conversion funnel, time-to-claim
 * distribution + percentiles, claimer-vs-non-claimer retention curves,
 * first-deposit cohort comparison, source + country breakdowns,
 * hour-of-day / day-of-week / heatmap, weekly cohort matrix, drop-off
 * causes, top recipients, and the geo time-series.
 *
 * Reuses the exact same cached query helpers the page renders. Signup
 * cost is house cost → rose in the UI; CSV carries raw machine values.
 * Read-only. Server-only; auth is enforced by the route handler that
 * calls this (`/insights/export`), which gates on the same page-access
 * key as the page.
 */
export async function gatherSignupExportSections(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [
    overviewR,
    funnelR,
    ttcR,
    retentionR,
    firstDepositR,
    sourceR,
    countryR,
    hodR,
    cohortMatrixR,
    dropOffR,
    topRecipientsR,
    geoTsR,
    dailyR,
  ] = await settle([
    getSignupOverview(period),
    getSignupFunnel(period),
    getSignupTimeToClaim(period),
    getSignupRetention(period),
    getSignupFirstDeposit(period),
    getSignupSourceBreakdown(period),
    getSignupCountryBreakdown(period),
    getSignupHourOfDay(period),
    getSignupCohortMatrix(period),
    getSignupDropOff(period),
    getSignupTopRecipients(period),
    getSignupGeoTimeSeries(period),
    getSignupDaily(period),
  ]);
  const overview = () => unwrap(overviewR);
  const funnel = () => unwrap(funnelR);
  const ttc = () => unwrap(ttcR);
  const retention = () => unwrap(retentionR);
  const firstDeposit = () => unwrap(firstDepositR);
  const source = () => unwrap(sourceR);
  const country = () => unwrap(countryR);
  const hod = () => unwrap(hodR);
  const cohortMatrix = () => unwrap(cohortMatrixR);
  const dropOff = () => unwrap(dropOffR);
  const topRecipients = () => unwrap(topRecipientsR);
  const geoTs = () => unwrap(geoTsR);
  const daily = () => unwrap(dailyR);

  const label = insightsRewardsPeriodLabel(period);

  const retentionRow = (window: string, v: RetentionCurveValue) => [
    window,
    v.claimerCount,
    v.claimerRetained,
    v.claimerShare,
    v.nonClaimerCount,
    v.nonClaimerRetained,
    v.nonClaimerShare,
    v.liftPct,
  ];
  const sourceColumns = [
    "Key",
    "Label",
    "Signups",
    "Claimants",
    "Claim rate",
    "Total cost (USD)",
    "Avg per claim (USD)",
    "Retention 7d share",
  ];
  const sourceRow = (r: SignupSourceRow) => [
    r.key,
    r.label,
    r.signups,
    r.claimants,
    r.claimRate,
    r.totalCost,
    r.avgPerClaim,
    r.retention7dShare,
  ];

  return [
    // ── Overview KPIs ─────────────────────────────────────────────
    buildSection(AREA, `Signup Reward Overview KPIs (${label})`, ["Metric", "Value"], () => {
      const o = overview();
      const prior = o.priorWindow;
      return [
        ["Period", label],
        ["Signups", o.signups],
        ["Claimants", o.claimants],
        ["Conversion %", o.conversionPct],
        ["Total cost (USD)", o.totalCost],
        ["Avg per claim (USD)", o.avgPerClaim],
        ["Avg per signup (USD)", o.avgPerSignup],
        ["First depositors", o.firstDepositors],
        ["First-deposit conversion %", o.firstDepositConversionPct],
        ["Median hours to claim", o.medianHoursToClaim],
        ["Signup delta vs prior", prior?.signupDelta ?? null],
        ["Claimant delta vs prior", prior?.claimantDelta ?? null],
        ["Cost delta vs prior", prior?.costDelta ?? null],
      ];
    }),

    // ── Daily series ──────────────────────────────────────────────
    buildSection(AREA, "Signup Daily Series", ["Date", "Signups", "Claims", "Cost (USD)"], () =>
      daily().map((d) => [d.date, d.signups, d.claims, d.cost]),
    ),

    // ── Funnel ────────────────────────────────────────────────────
    buildSection(AREA, "Signup Funnel", ["Stage", "Count"], () => {
      const f = funnel();
      return [
        ["Signups", f.signups],
        ["Claimed", f.claimed],
        ["First deposit", f.firstDeposit],
        ["First wager", f.firstWager],
        ["Repeat deposit", f.repeatDeposit],
      ];
    }),

    // ── Time-to-claim ─────────────────────────────────────────────
    buildSection(AREA, "Signup Time-to-Claim — Summary", ["Metric", "Value"], () => {
      const t = ttc();
      return [
        ["Claimants", t.claimants],
        ["Never claimed", t.neverClaimed],
        ["Median (hours)", t.medianHours],
        ["P25 (hours)", t.p25Hours],
        ["P75 (hours)", t.p75Hours],
        ["P95 (hours)", t.p95Hours],
        ["Share within 1h", t.shareWithin1h],
        ["Share within 1d", t.shareWithin1d],
        ["Share within 7d", t.shareWithin7d],
        ["Share within 30d", t.shareWithin30d],
      ];
    }),
    buildSection(
      AREA,
      "Signup Time-to-Claim — Distribution",
      ["Bucket", "Count", "Edge (hours)"],
      () => ttc().buckets.map((b) => [b.label, b.count, b.edgeHours]),
    ),

    // ── Retention curves (claimer vs non-claimer) ─────────────────
    buildSection(
      AREA,
      "Signup Retention (claimer vs non-claimer)",
      [
        "Window",
        "Claimer count",
        "Claimer retained",
        "Claimer share",
        "Non-claimer count",
        "Non-claimer retained",
        "Non-claimer share",
        "Lift %",
      ],
      () => {
        const r = retention();
        return [
          retentionRow("24h", r.retention24h),
          retentionRow("7d", r.retention7d),
          retentionRow("30d", r.retention30d),
        ];
      },
    ),

    // ── First deposit cohort ──────────────────────────────────────
    buildSection(
      AREA,
      "Signup First Deposit — Cohort Comparison",
      ["Metric", "Claimers", "Non-claimers"],
      () => {
        const fd = firstDeposit();
        return [
          ["Users", fd.claimers.users, fd.nonClaimers.users],
          ["Avg (USD)", fd.claimers.avg, fd.nonClaimers.avg],
          ["Median (USD)", fd.claimers.median, fd.nonClaimers.median],
          ["Total (USD)", fd.claimers.total, fd.nonClaimers.total],
        ];
      },
    ),
    buildSection(
      AREA,
      "Signup First Deposit — Buckets",
      ["Bucket", "Edge (USD)", "Claimer count", "Non-claimer count"],
      () =>
        firstDeposit().buckets.map((b) => [b.label, b.edgeUsd, b.claimerCount, b.nonClaimerCount]),
    ),

    // ── Source breakdown ──────────────────────────────────────────
    buildSection(AREA, "Signup Source — Providers", sourceColumns, () =>
      source().providers.map(sourceRow),
    ),
    buildSection(AREA, "Signup Source — Affiliates", sourceColumns, () =>
      source().affiliates.map(sourceRow),
    ),

    // ── Country breakdown ─────────────────────────────────────────
    buildSection(
      AREA,
      "Signup by Country",
      ["Country", "Signups", "Claimants", "Claim rate", "Claim volume (USD)", "Avg per claim (USD)"],
      () =>
        country().countries.map((r) => [
          r.code,
          r.signups,
          r.claimants,
          r.claimRate,
          r.claimVolume,
          r.avgPerClaim,
        ]),
    ),
    buildSection(
      AREA,
      "Signup by Continent",
      ["Continent", "Signups", "Claimants", "Claim rate"],
      () => country().continents.map((r) => [r.code, r.signups, r.claimants, r.claimRate]),
    ),

    // ── Hour-of-day / day-of-week / heatmap ───────────────────────
    buildSection(AREA, "Signup Hour-of-Day", ["Hour", "Count", "Volume (USD)"], () =>
      hod().hourly.map((b) => [b.label, b.count, b.volume]),
    ),
    buildSection(
      AREA,
      "Signup Day-of-Week",
      ["Day index", "Day", "Count", "Volume (USD)"],
      () => hod().dayOfWeek.map((b) => [b.index, b.label, b.count, b.volume]),
    ),
    buildSection(
      AREA,
      "Signup Heatmap (day x hour)",
      ["Day of week (0=Sun)", "Hour", "Count", "Volume (USD)"],
      () => hod().heatmap.map((c) => [c.dow, c.hour, c.count, c.volume]),
    ),

    // ── Cohort matrix ─────────────────────────────────────────────
    buildSection(
      AREA,
      "Signup Weekly Cohort Matrix",
      [
        "Week",
        "Signups",
        "Claimers",
        "Claim rate",
        "Retained 30d",
        "Retained 30d share",
        "Claimer retained 30d",
        "Claimer retained 30d share",
        "Non-claimer retained 30d",
        "Non-claimer retained 30d share",
        "Retention window complete",
      ],
      () =>
        cohortMatrix().map((r) => [
          r.week,
          r.signups,
          r.claimers,
          r.claimRate,
          r.retained30d,
          r.retained30dShare,
          r.claimerRetained30d,
          r.claimerRetained30dShare,
          r.nonClaimerRetained30d,
          r.nonClaimerRetained30dShare,
          r.retentionWindowComplete ? "yes" : "no",
        ]),
    ),

    // ── Drop-off causes ───────────────────────────────────────────
    buildSection(AREA, "Signup Drop-off Causes", ["Metric", "Value"], () => {
      const d = dropOff();
      return [
        ["Cohort size", d.cohortSize],
        ["Claimers", d.claimers],
        ["Dormant", d.dormant],
        ["Deposited, no claim", d.depositedNoClaim],
        ["Wagered, no claim", d.wageredNoClaim],
        ["Banned or locked", d.bannedOrLocked],
        ["Other", d.other],
      ];
    }),

    // ── Top recipients ────────────────────────────────────────────
    buildSection(
      AREA,
      "Signup Top Recipients",
      [
        "User ID",
        "Username",
        "Country",
        "Signed up at (UTC)",
        "Claim count",
        "Claim volume (USD)",
        "Largest claim (USD)",
        "First claim at (UTC)",
        "Last claim at (UTC)",
        "Deposit total (USD)",
      ],
      () =>
        topRecipients().map((r) => [
          r.userId,
          r.username,
          r.countryCode,
          r.signedUpAt,
          r.claimCount,
          r.claimVolume,
          r.largestClaim,
          r.firstClaimAt,
          r.lastClaimAt,
          r.depositTotal,
        ]),
    ),

    // ── Geo time-series (long format) ─────────────────────────────
    buildSection(
      AREA,
      "Signup Geo Time Series (top countries)",
      ["Country", "Date", "Signups", "Claimers"],
      () => {
        const rows: (string | number)[][] = [];
        for (const c of geoTs()) {
          for (const d of c.daily) {
            rows.push([c.code, d.date, d.signups, d.claimers]);
          }
        }
        return rows;
      },
    ),
  ];
}
