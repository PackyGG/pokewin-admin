"use server";

import { requirePageAccess } from "@/lib/dal";
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
import { getSignupSourceBreakdown } from "@/lib/queries/insights-rewards/signup/source";
import { getSignupCountryBreakdown } from "@/lib/queries/insights-rewards/signup/country";
import { getSignupHourOfDay } from "@/lib/queries/insights-rewards/signup/hour-of-day";
import { getSignupCohortMatrix } from "@/lib/queries/insights-rewards/signup/cohort-matrix";
import { getSignupDropOff } from "@/lib/queries/insights-rewards/signup/drop-off";
import { getSignupTopRecipients } from "@/lib/queries/insights-rewards/signup/top-recipients";
import { getSignupGeoTimeSeries } from "@/lib/queries/insights-rewards/signup/geo-timeseries";
import { getSignupDaily } from "@/lib/queries/insights-rewards/signup/daily";
import type { RetentionCurveValue } from "@/lib/queries/insights-rewards/signup/retention";

/**
 * Server export action for /insights/rewards/signup.
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
 * Read-only. Gated by the same page-access check as the page.
 */
export async function exportSignupData(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  await requirePageAccess("/insights/rewards/signup");

  const [
    overview,
    funnel,
    ttc,
    retention,
    firstDeposit,
    source,
    country,
    hod,
    cohortMatrix,
    dropOff,
    topRecipients,
    geoTs,
    daily,
  ] = await Promise.all([
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

  const label = insightsRewardsPeriodLabel(period);
  const prior = overview.priorWindow;
  const sections: ExportSection[] = [];

  // ── Overview KPIs ───────────────────────────────────────────────
  sections.push({
    name: `Signup Reward Overview KPIs (${label})`,
    columns: ["Metric", "Value"],
    rows: [
      ["Period", label],
      ["Signups", overview.signups],
      ["Claimants", overview.claimants],
      ["Conversion %", overview.conversionPct],
      ["Total cost (USD)", overview.totalCost],
      ["Avg per claim (USD)", overview.avgPerClaim],
      ["Avg per signup (USD)", overview.avgPerSignup],
      ["First depositors", overview.firstDepositors],
      ["First-deposit conversion %", overview.firstDepositConversionPct],
      ["Median hours to claim", overview.medianHoursToClaim],
      ["Signup delta vs prior", prior?.signupDelta ?? null],
      ["Claimant delta vs prior", prior?.claimantDelta ?? null],
      ["Cost delta vs prior", prior?.costDelta ?? null],
    ],
  });

  // ── Daily series ────────────────────────────────────────────────
  sections.push({
    name: "Signup Daily Series",
    columns: ["Date", "Signups", "Claims", "Cost (USD)"],
    rows: daily.map((d) => [d.date, d.signups, d.claims, d.cost]),
  });

  // ── Funnel ──────────────────────────────────────────────────────
  sections.push({
    name: "Signup Funnel",
    columns: ["Stage", "Count"],
    rows: [
      ["Signups", funnel.signups],
      ["Claimed", funnel.claimed],
      ["First deposit", funnel.firstDeposit],
      ["First wager", funnel.firstWager],
      ["Repeat deposit", funnel.repeatDeposit],
    ],
  });

  // ── Time-to-claim ───────────────────────────────────────────────
  sections.push({
    name: "Signup Time-to-Claim — Summary",
    columns: ["Metric", "Value"],
    rows: [
      ["Claimants", ttc.claimants],
      ["Never claimed", ttc.neverClaimed],
      ["Median (hours)", ttc.medianHours],
      ["P25 (hours)", ttc.p25Hours],
      ["P75 (hours)", ttc.p75Hours],
      ["P95 (hours)", ttc.p95Hours],
      ["Share within 1h", ttc.shareWithin1h],
      ["Share within 1d", ttc.shareWithin1d],
      ["Share within 7d", ttc.shareWithin7d],
      ["Share within 30d", ttc.shareWithin30d],
    ],
  });
  sections.push({
    name: "Signup Time-to-Claim — Distribution",
    columns: ["Bucket", "Count", "Edge (hours)"],
    rows: ttc.buckets.map((b) => [b.label, b.count, b.edgeHours]),
  });

  // ── Retention curves (claimer vs non-claimer) ───────────────────
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
  sections.push({
    name: "Signup Retention (claimer vs non-claimer)",
    columns: [
      "Window",
      "Claimer count",
      "Claimer retained",
      "Claimer share",
      "Non-claimer count",
      "Non-claimer retained",
      "Non-claimer share",
      "Lift %",
    ],
    rows: [
      retentionRow("24h", retention.retention24h),
      retentionRow("7d", retention.retention7d),
      retentionRow("30d", retention.retention30d),
    ],
  });

  // ── First deposit cohort ────────────────────────────────────────
  sections.push({
    name: "Signup First Deposit — Cohort Comparison",
    columns: ["Metric", "Claimers", "Non-claimers"],
    rows: [
      ["Users", firstDeposit.claimers.users, firstDeposit.nonClaimers.users],
      ["Avg (USD)", firstDeposit.claimers.avg, firstDeposit.nonClaimers.avg],
      ["Median (USD)", firstDeposit.claimers.median, firstDeposit.nonClaimers.median],
      ["Total (USD)", firstDeposit.claimers.total, firstDeposit.nonClaimers.total],
    ],
  });
  sections.push({
    name: "Signup First Deposit — Buckets",
    columns: ["Bucket", "Edge (USD)", "Claimer count", "Non-claimer count"],
    rows: firstDeposit.buckets.map((b) => [
      b.label,
      b.edgeUsd,
      b.claimerCount,
      b.nonClaimerCount,
    ]),
  });

  // ── Source breakdown ────────────────────────────────────────────
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
  sections.push({
    name: "Signup Source — Providers",
    columns: sourceColumns,
    rows: source.providers.map((r) => [
      r.key,
      r.label,
      r.signups,
      r.claimants,
      r.claimRate,
      r.totalCost,
      r.avgPerClaim,
      r.retention7dShare,
    ]),
  });
  sections.push({
    name: "Signup Source — Affiliates",
    columns: sourceColumns,
    rows: source.affiliates.map((r) => [
      r.key,
      r.label,
      r.signups,
      r.claimants,
      r.claimRate,
      r.totalCost,
      r.avgPerClaim,
      r.retention7dShare,
    ]),
  });

  // ── Country breakdown ───────────────────────────────────────────
  sections.push({
    name: "Signup by Country",
    columns: [
      "Country",
      "Signups",
      "Claimants",
      "Claim rate",
      "Claim volume (USD)",
      "Avg per claim (USD)",
    ],
    rows: country.countries.map((r) => [
      r.code,
      r.signups,
      r.claimants,
      r.claimRate,
      r.claimVolume,
      r.avgPerClaim,
    ]),
  });
  sections.push({
    name: "Signup by Continent",
    columns: ["Continent", "Signups", "Claimants", "Claim rate"],
    rows: country.continents.map((r) => [
      r.code,
      r.signups,
      r.claimants,
      r.claimRate,
    ]),
  });

  // ── Hour-of-day / day-of-week / heatmap ─────────────────────────
  sections.push({
    name: "Signup Hour-of-Day",
    columns: ["Hour", "Count", "Volume (USD)"],
    rows: hod.hourly.map((b) => [b.label, b.count, b.volume]),
  });
  sections.push({
    name: "Signup Day-of-Week",
    columns: ["Day index", "Day", "Count", "Volume (USD)"],
    rows: hod.dayOfWeek.map((b) => [b.index, b.label, b.count, b.volume]),
  });
  sections.push({
    name: "Signup Heatmap (day x hour)",
    columns: ["Day of week (0=Sun)", "Hour", "Count", "Volume (USD)"],
    rows: hod.heatmap.map((c) => [c.dow, c.hour, c.count, c.volume]),
  });

  // ── Cohort matrix ───────────────────────────────────────────────
  sections.push({
    name: "Signup Weekly Cohort Matrix",
    columns: [
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
    rows: cohortMatrix.map((r) => [
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
  });

  // ── Drop-off causes ─────────────────────────────────────────────
  sections.push({
    name: "Signup Drop-off Causes",
    columns: ["Metric", "Value"],
    rows: [
      ["Cohort size", dropOff.cohortSize],
      ["Claimers", dropOff.claimers],
      ["Dormant", dropOff.dormant],
      ["Deposited, no claim", dropOff.depositedNoClaim],
      ["Wagered, no claim", dropOff.wageredNoClaim],
      ["Banned or locked", dropOff.bannedOrLocked],
      ["Other", dropOff.other],
    ],
  });

  // ── Top recipients ──────────────────────────────────────────────
  sections.push({
    name: "Signup Top Recipients",
    columns: [
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
    rows: topRecipients.map((r) => [
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
  });

  // ── Geo time-series (long format) ───────────────────────────────
  const geoRows: (string | number)[][] = [];
  for (const c of geoTs) {
    for (const d of c.daily) {
      geoRows.push([c.code, d.date, d.signups, d.claimers]);
    }
  }
  sections.push({
    name: "Signup Geo Time Series (top countries)",
    columns: ["Country", "Date", "Signups", "Claimers"],
    rows: geoRows,
  });

  return sections;
}
