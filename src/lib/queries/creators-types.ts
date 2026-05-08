export type CreatorPnlPeriod = {
  period: string;
  ggr: number;
  costs: number;
  netPnl: number;
};

export type CreatorPnlData = {
  totalGgr: number;
  totalCosts: number;
  totalNetPnl: number;
  creatorCost: number;
  truePlatformPnl: number;
  byPeriod: CreatorPnlPeriod[];
};

export type CreatorLimits = {
  currencyLimitAmount: number | null;
  percentageLimit: number | null;
  tipLimit: number | null;
  currencyLimitResetDays: number | null;
};

export type CreatorListItem = {
  userId: string;
  username: string | null;
  code: string;
  // Every code this creator owns, oldest-first. The `code` field
  // above is the primary (oldest); this array carries the full set
  // plus their ids so the inline codes editor can remove specific
  // rows.
  codes: { id: string; code: string }[];
  // True when this creator has at least one creator_deals row with
  // status='active' AND no future end_date. Drives the "Active"
  // indicator in the Username cell + the primary sort key in the
  // /creators list query.
  hasActiveDeal: boolean;
  level: number;
  totalReferred: number;
  totalSignups: number;
  totalEarnedUsd: number;
  availableUsd: number;
  totalPaidOutUsd: number;
  // 3-day rolling deposit + wager volume from this creator's
  // affiliate referrals (staff-excluded). Surfaces "active right
  // now" momentum on the row alongside the all-time totals.
  deposits3dUsd: number;
  wagers3dUsd: number;
  limits: CreatorLimits;
};

export type UserSearchResult = {
  userId: string;
  username: string | null;
  email: string | null;
  role: string;
};

export type CodeListItem = {
  code: string;
  ownerUserId: string;
  ownerUsername: string | null;
  isActive: boolean;
  createdAt: string;
};

export type AffiliateAnalyticsData = {
  totalSignups: number;
  totalCommissionPaid: number;
  totalWagerVolume: number;
  totalDepositVolume: number;
  totalClicks: number;
  activeCreators: number;
  daily: {
    date: string;
    signups: number;
    commission: number;
    wagerVolume: number;
    depositVolume: number;
    clicks: number;
  }[];
};

export type CreatorTipItem = {
  id: string;
  rainId: string;
  amountUsd: number;
  rainTotalPool: number;
  rainStatus: string;
  rainWinnerUsername: string | null;
  createdAt: string;
};
