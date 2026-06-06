/** Serializable chart bucket — legacy single-series shape. */
export type HubChartPoint = {
  label: string;
  value: number;
};

/** Matches main `/dashboard` WagerChart input (creator-code cohort scoped). */
export type HubWagerChartRow = {
  date: string;
  packs: number;
  battles: number;
  upgrader: number;
};

/** Matches main `/dashboard` DepositsChart input. */
export type HubDepositChartRow = {
  date: string;
  amount: number;
};

/** Daily sign-ups + FTDs for the overview acquisition chart (30d buckets). */
export type HubSignupsFtdsChartRow = {
  date: string;
  signups: number;
  ftds: number;
};
