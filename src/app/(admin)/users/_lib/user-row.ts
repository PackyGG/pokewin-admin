/** Serializable row model shared by the users table and its sort state. */
export type UserRow = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  status: string;
  country: string | null;
  countryCode: string | null;
  /** Referral code retained in the row even while its column is hidden. */
  affiliateCode: string | null;
  availableBalance: number;
  /** Cash + locked vault + open inventory. */
  netHoldings: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalWagered: number;
  pnl: number;
  createdAt: string;
  suspectedAlt: boolean;
  hasDeviceId: boolean;
  deviceVisitorId: string | null;
  signupIpSharedCount: number;
  signupProvider: string | null;
};
