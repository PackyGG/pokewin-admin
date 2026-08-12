import assert from "node:assert/strict";
import test from "node:test";

import type { CreatorDealResponse } from "../../src/lib/backend-api/contracts";
import { summarizeDealTermPeriods } from "../../src/lib/deal-term-periods";
import { costBreakdown } from "../../src/app/(creator-hub)/creator-hub/profitability/_components/deal-formatters";

function deal(overrides: Partial<CreatorDealResponse> = {}): CreatorDealResponse {
  return {
    id: "deal-1",
    user_id: "creator-1",
    status: "active",
    week_start_utc: "2026-08-01T00:00:00.000Z",
    week_end_utc: "2026-08-15T00:00:00.000Z",
    fills_allowed: 2,
    fills_used: 0,
    per_fill_amount_usd: "100",
    conversion_rate_bps: 10000,
    total_withdraw_cap_usd: "750",
    withdraw_cap_used_usd: "0",
    cooldown_minutes: 0,
    max_tip_per_stream_usd: "10",
    max_tip_per_user_usd: "10",
    max_sponsored_battle_usd: "0",
    max_sponsorship_per_stream_usd: "20",
    allow_site_leaderboards: false,
    allow_code_leaderboards: false,
    terms: null,
    created_by: null,
    version: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

test("reports one two-week cap as two-week, never weekly", () => {
  assert.deepEqual(summarizeDealTermPeriods([deal()]), {
    periodDays: 14,
    periodCount: 1,
    capPerPeriodUsd: 750,
    tipSponsorPerPeriodUsd: 60,
  });
});

test("reports independently recurring weekly rows", () => {
  const first = deal({ week_end_utc: "2026-08-08T00:00:00.000Z" });
  const second = deal({
    id: "deal-2",
    week_start_utc: "2026-08-08T00:00:00.000Z",
    week_end_utc: "2026-08-15T00:00:00.000Z",
  });
  assert.deepEqual(summarizeDealTermPeriods([first, second]), {
    periodDays: 7,
    periodCount: 2,
    capPerPeriodUsd: 750,
    tipSponsorPerPeriodUsd: 60,
  });
});

test("mixed legacy rows omit a misleading per-period average", () => {
  assert.deepEqual(
    summarizeDealTermPeriods([
      deal({ week_end_utc: "2026-08-08T00:00:00.000Z" }),
      deal({
        id: "deal-2",
        week_start_utc: "2026-08-08T00:00:00.000Z",
        week_end_utc: "2026-08-15T00:00:00.000Z",
        total_withdraw_cap_usd: "900",
      }),
    ]),
    {
      periodDays: 7,
      periodCount: 2,
      capPerPeriodUsd: null,
      tipSponsorPerPeriodUsd: 60,
    },
  );
});

test("profitability labels a 14-day cap per two weeks", () => {
  const label = costBreakdown({
    dealWeeks: 2,
    capUsd: 750,
    capPerPeriodUsd: 750,
    termPeriodDays: 14,
    termPeriodCount: 1,
    tipSponsorUsd: 0,
    tipSponsorPerPeriodUsd: 0,
    leaderboardUsd: 0,
  });
  assert.match(label, /750.*per 2 weeks/i);
  assert.doesNotMatch(label, /\/wk|per week(?!s)/i);
});

test("profitability identifies each independently enforced weekly period", () => {
  const label = costBreakdown({
    dealWeeks: 2,
    capUsd: 1500,
    capPerPeriodUsd: 750,
    termPeriodDays: 7,
    termPeriodCount: 2,
    tipSponsorUsd: 0,
    tipSponsorPerPeriodUsd: 0,
    leaderboardUsd: 0,
  });
  assert.match(label, /750.*per week.*2 periods/i);
});
