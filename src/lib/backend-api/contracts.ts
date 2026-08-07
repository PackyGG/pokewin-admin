/** Shared data contracts for backend HTTP responses and PostgreSQL fallbacks. */

export type CreatorDealStatus =
  | "scheduled"
  | "active"
  | "completed"
  | "terminated";
export type StreamSessionStatus = "active" | "ended" | "converted";
export type PendingConversionStatus = "pending" | "claimed";

export type CreatorListItem = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: "user" | "support" | "admin" | "creator";
  created_at: string;
  current_deal: {
    id: string;
    status: CreatorDealStatus;
    week_start_utc: string;
    week_end_utc: string;
    fills_allowed: number;
    fills_used: number;
    per_fill_amount_usd: string;
  } | null;
  active_session_id: string | null;
  total_deals_count: number;
};

export type CreatorDealResponse = {
  id: string;
  user_id: string;
  status: CreatorDealStatus;
  week_start_utc: string;
  week_end_utc: string;
  fills_allowed: number;
  fills_used: number;
  per_fill_amount_usd: string;
  conversion_rate_bps: number;
  total_withdraw_cap_usd: string | null;
  withdraw_cap_used_usd: string;
  cooldown_minutes: number;
  max_tip_per_stream_usd: string;
  max_tip_per_user_usd: string;
  max_sponsored_battle_usd: string;
  max_sponsorship_per_stream_usd: string;
  allow_site_leaderboards: boolean;
  allow_code_leaderboards: boolean;
  terms: unknown;
  created_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
};

export type CreatorSessionResponse = {
  id: string;
  deal_id: string;
  user_id: string;
  status: StreamSessionStatus;
  activated_at: string;
  first_bet_at: string | null;
  ended_at: string | null;
  converted_at: string | null;
  auto_end_at: string | null;
  fill_loaded_usd: string;
  fill_spent_usd: string;
  fill_refunded_usd: string;
  fill_remaining_usd: string;
  tips_spent_this_session_usd: string;
  sponsorship_spent_this_session_usd: string;
  ending_balance_usd: string | null;
  conversion_rate_bps_snapshot: number | null;
  converted_to_raw_usd: string | null;
  version: number;
  created_at: string;
};

export type PendingConversionResponse = {
  id: string;
  session_id: string;
  deal_id: string;
  user_id: string;
  source: "battle_win" | "battle_refund";
  amount_usd: string;
  battle_id: string | null;
  conversion_rate_bps_snapshot: number;
  status: PendingConversionStatus;
  claimed_at: string | null;
  created_at: string;
};

export type CreatorSocialPlatform =
  | "twitch"
  | "kick"
  | "youtube"
  | "x"
  | "instagram"
  | "tiktok"
  | "discord";
export type CreatorSocialStatus = "pending" | "approved" | "rejected";
export type CreatorSocialResponse = {
  id: string;
  user_id: string;
  platform: CreatorSocialPlatform;
  username: string;
  url: string | null;
  status: CreatorSocialStatus;
  submitted_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
};
export type AdminCreatorSocial = CreatorSocialResponse & {
  creator_username: string | null;
  creator_image: string | null;
};

export type ApprovalStatus = "pending" | "approved" | "rejected";
export type TimeStatus = "upcoming" | "active" | "ended";
export type PrizeTier = { position: number; prize_amount_usd: string };
export type LeaderboardAdminRow = {
  id: string;
  creator_user_id: string;
  co_creator_user_ids: string[];
  title: string;
  affiliate_codes: string[];
  creator_prize_usd: string;
  site_bonus_usd: string;
  total_prize_usd: string;
  is_sponsored: boolean;
  start_date: string;
  end_date: string;
  created_at: string;
  approval_status: ApprovalStatus;
  approved_at: string | null;
  approved_by: string | null;
  rejection_reason: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  refunded_at: string | null;
  refund_amount_usd: string | null;
  creation_ledger_tx_id: string | null;
  refund_ledger_tx_id: string | null;
  paid_manually: boolean;
  payout_note: string | null;
  time_status: TimeStatus;
  prize_tiers: PrizeTier[];
};
export type LeaderboardListQuery = {
  status?: ApprovalStatus;
  creator_user_id?: string;
  include_cancelled?: boolean;
  offset?: number;
  limit?: number;
};
export type LeaderboardListResult = {
  leaderboards: LeaderboardAdminRow[];
  total: number;
  offset: number;
  limit: number;
};
