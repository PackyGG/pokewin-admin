import assert from "node:assert/strict";
import test from "node:test";

import type { CreatorDealResponse } from "../../src/lib/backend-api/contracts";
import {
  getCreatorApprovalDealMarker,
  indexCreatorApprovalDealIds,
  selectLiveCreatorDealPeriods,
} from "../../src/lib/creator-approval-deal-ids";

function markedDeal(id: string, requestId: string, periodIndex: number): CreatorDealResponse {
  return {
    id,
    user_id: "creator-1",
    status: "active",
    week_start_utc: "2026-08-01T00:00:00.000Z",
    week_end_utc: "2026-08-08T00:00:00.000Z",
    fills_allowed: 1,
    fills_used: 0,
    per_fill_amount_usd: "100",
    conversion_rate_bps: 10000,
    total_withdraw_cap_usd: "750",
    withdraw_cap_used_usd: "0",
    cooldown_minutes: 0,
    max_tip_per_stream_usd: "0",
    max_tip_per_user_usd: "0",
    max_sponsored_battle_usd: "0",
    max_sponsorship_per_stream_usd: "0",
    allow_site_leaderboards: false,
    allow_code_leaderboards: false,
    terms: {
      creator_approval_request_id: requestId,
      creator_approval_period_index: periodIndex,
      creator_approval_period_count: 2,
    },
    created_by: null,
    version: 1,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

test("indexes every segmented deal in period order", () => {
  const indexed = indexCreatorApprovalDealIds([
    markedDeal("second", "request-1", 1),
    markedDeal("first", "request-1", 0),
    markedDeal("other", "request-2", 0),
  ]);
  assert.deepEqual(indexed.get("request-1"), ["first", "second"]);
  assert.deepEqual(indexed.get("request-2"), ["other"]);
});

test("ignores unrelated and malformed terms", () => {
  const malformed = markedDeal("bad", "request-1", 0);
  malformed.terms = { creator_approval_request_id: "request-1" };
  const unrelated = markedDeal("old", "request-1", 0);
  unrelated.terms = null;
  assert.equal(indexCreatorApprovalDealIds([malformed, unrelated]).size, 0);
});

test("keeps every active and scheduled period for the current deal card", () => {
  const active = markedDeal("active", "request-1", 0);
  const scheduled = markedDeal("scheduled", "request-1", 1);
  scheduled.status = "scheduled";
  scheduled.week_start_utc = "2026-08-08T00:00:00.000Z";
  scheduled.week_end_utc = "2026-08-15T00:00:00.000Z";
  const completed = markedDeal("completed", "request-old", 0);
  completed.status = "completed";

  assert.deepEqual(
    selectLiveCreatorDealPeriods([scheduled, completed, active]).map((row) => row.id),
    ["active", "scheduled"],
  );
  assert.deepEqual(getCreatorApprovalDealMarker(scheduled), {
    requestId: "request-1",
    periodIndex: 1,
    periodCount: 2,
  });
});
