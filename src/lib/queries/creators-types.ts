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
  level: number;
  totalReferred: number;
  totalSignups: number;
  totalEarnedUsd: number;
  availableUsd: number;
  totalPaidOutUsd: number;
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
