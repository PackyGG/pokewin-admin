export type AdminPage = {
  group: string;
  label: string;
  key: string;
};

export const ADMIN_PAGES: AdminPage[] = [
  // Navigation
  { group: "Navigation", label: "Dashboard", key: "/dashboard" },
  { group: "Navigation", label: "Shifts", key: "/shifts" },
  { group: "Navigation", label: "Analytics", key: "/analytics" },
  { group: "Navigation", label: "Map", key: "/map" },
  { group: "Navigation", label: "Users", key: "/users" },
  { group: "Navigation", label: "Withdrawals", key: "/withdrawals" },
  // Transactions
  { group: "Transactions", label: "All", key: "/transactions" },
  { group: "Transactions", label: "Packs", key: "/transactions/packs" },
  { group: "Transactions", label: "Battles", key: "/transactions/battles" },
  { group: "Transactions", label: "Rewards", key: "/transactions/rewards" },
  { group: "Transactions", label: "Deposits & Withdrawals", key: "/transactions/deposits" },
  // Content
  { group: "Content", label: "Packs", key: "/packs" },
  { group: "Content", label: "Cards", key: "/cards" },
  { group: "Content", label: "Battles", key: "/battles" },
  // Rewards
  { group: "Rewards", label: "Rewards", key: "/rewards" },
  { group: "Rewards", label: "Rakeback", key: "/rewards/rakeback" },
  { group: "Rewards", label: "Raffles", key: "/rewards/raffles" },
  { group: "Rewards", label: "Rain", key: "/rain" },
  { group: "Rewards", label: "Leaderboards", key: "/rewards/leaderboards" },
  { group: "Rewards", label: "Level Up", key: "/rewards/level-up" },
  { group: "Rewards", label: "Settings", key: "/rewards/settings" },
  // Marketing
  { group: "Marketing", label: "Promo Codes", key: "/promo-codes" },
  { group: "Marketing", label: "Gift Cards", key: "/gift-cards" },
  { group: "Marketing", label: "Vouchers", key: "/vouchers" },
  // Finance
  { group: "Finance", label: "Spending", key: "/spending" },
  // Creator Portal
  { group: "Creator Portal", label: "My Profile", key: "/my-profile" },
  // Creators
  { group: "Creators", label: "Creators", key: "/creators" },
  { group: "Creators", label: "Codes", key: "/creators/codes" },
  { group: "Creators", label: "Ads", key: "/creators/ads" },
  { group: "Creators", label: "Analytics", key: "/creators/analytics" },
  { group: "Creators", label: "Settings", key: "/creators/settings" },
  { group: "Creators", label: "Leaderboards", key: "/creators/leaderboards" },
  // Moderation
  { group: "Moderation", label: "Chat", key: "/chat" },
  // Security
  { group: "Security", label: "Security", key: "/security" },
  // System
  { group: "System", label: "Admin Users", key: "/admin-users" },
  { group: "System", label: "Admin Roles", key: "/admin-users/roles" },
  { group: "System", label: "Role Permissions", key: "/settings/roles" },
  { group: "System", label: "Bots", key: "/bots" },
  { group: "System", label: "Settings", key: "/settings" },
  { group: "System", label: "Audit Log", key: "/audit" },
  { group: "System", label: "Commands", key: "/system/commands" },
  { group: "System", label: "Dashboard Stats", key: "/system/stats" },
];

export const ALL_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);
