"use client";

/**
 * Client wrapper that constructs a complete, type-correct KPI-window
 * fixture and renders the REAL <DashboardKpiSection>. See ./page.tsx for
 * why this dev-only fixture exists.
 *
 * It is NOT a reimplementation — it imports and renders the production
 * component so the harness measures the real GGR sub-chip row (the
 * relabelled "Net wager" chip + its exclusion hint) and the Wager tile's
 * "Total" / "Organic" headline pair, exactly as they ship.
 *
 * The fixture numbers reproduce the owner's "two wager numbers side by
 * side" case: the GGR-basis net wager (~9k, the GGR box chip) sits ~3x
 * below the gross wager Total (~30k, the Wager tile), so the
 * disambiguation copy can be read in context.
 */

import {
  DashboardKpiSection,
  type KpiSnapshotValues,
} from "@/app/(admin)/dashboard/dashboard-kpi-section";
import type { KpiWindowPayload } from "@/app/(admin)/dashboard/kpi-window-data";

const TODAY: KpiWindowPayload = {
  window: "today",
  windowLabel: "Today (since 00:00 UTC)",
  // GGR headline (house POV; positive = house up).
  ggr: 1850.0,
  // Gross wager (Wager tile "Total") — includes borrow-funded stakes +
  // reward/daily packs, so ~3x the GGR-basis net wager below.
  wager: 30120.0,
  wagerBreakdown: { packs: 18000.0, battles: 9120.0, upgrader: 3000.0 },
  wagerOrganic: 21000.0,
  deposits: 12400.0,
  depositCount: 38,
  withdrawals: 4200.0,
  withdrawalCount: 9,
  // GGR breakdown legs — net wager (wagersTotal) is the GGR basis (~9k),
  // deliberately smaller than the gross Wager tile Total (~30k).
  ggrBreakdown: {
    wagers: [
      { type: "pack_opening", total: 6200.0 },
      { type: "battle_bet", total: 2100.0 },
      { type: "upgrader_bet", total: 720.0 },
    ],
    payouts: [
      { type: "battle_refund", total: 5100.0 },
      { type: "upgrader_payout", total: 870.0 },
    ],
    wagersTotal: 9020.0,
    payoutsTotal: 7170.0,
    ggr: 1850.0,
  },
};

const SNAPSHOT: KpiSnapshotValues = {
  usersTotal: 124900,
  usersToday: 210,
  usersWeek: 1480,
  ftds24h: 42,
  ftdTotal24h: 5300.0,
  ftdAvg24h: 126.19,
  uniqueDepositors: 38200,
  depositorsPctOfUsers: 30.6,
  avgDeposit: 84.5,
  depositsPerHour24h: 1.6,
  depositsPerHour7d: 1.3,
  avgRtp: 92.4,
};

export function DashboardKpiFixtureClient() {
  return <DashboardKpiSection today={TODAY} snapshot={SNAPSHOT} />;
}
