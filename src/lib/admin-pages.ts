export type AdminPage = {
  group: string;
  label: string;
  key: string;
};

export const ADMIN_PAGES: AdminPage[] = [
  // Navigation
  { group: "Navigation", label: "Dashboard", key: "/dashboard" },
  { group: "Navigation", label: "Analytics", key: "/analytics" },
  { group: "Navigation", label: "Raw P&L", key: "/analytics/pure-pnl" },
  // /map was folded into /analytics as a tab — its permission inherits
  // from /analytics. The standalone page no longer exists.
  { group: "Navigation", label: "Users", key: "/users" },
  // Recovery bin for hard-deleted users — 7-day snapshot window. Gated
  // by the same __can_delete_user capability since restoring is the
  // inverse of deleting.
  { group: "Navigation", label: "Deleted Users", key: "/users/deleted" },
  // Standalone /withdrawals route is now a redirect to
  // /transactions/deposits?tab=withdrawals (the unified Transactions
  // page with deposits + withdrawals tabs). The permission key is
  // retained so support users who only had explicit withdrawals
  // access still pass requirePageAccess on the legacy route; the
  // combined page itself gates on `/transactions/deposits`.
  { group: "Navigation", label: "Withdrawals (legacy)", key: "/withdrawals" },
  // Transactions
  // Standalone /transactions overview removed — admins land on a
  // specific sub-ledger instead. Each sub-page carries its own
  // permission key.
  { group: "Transactions", label: "Packs", key: "/transactions/packs" },
  { group: "Transactions", label: "Battles", key: "/battles" },
  { group: "Transactions", label: "Rewards", key: "/transactions/rewards" },
  { group: "Transactions", label: "Transactions", key: "/transactions/deposits" },
  { group: "Transactions", label: "Upgrader", key: "/transactions/upgrader" },
  // Content
  { group: "Content", label: "Packs", key: "/packs" },
  { group: "Content", label: "Cards", key: "/cards" },
  { group: "Content", label: "Sets", key: "/sets" },
  { group: "Content", label: "Upgrader", key: "/upgrader" },
  // Rewards
  { group: "Rewards", label: "Rewards", key: "/rewards" },
  { group: "Rewards", label: "Analytics", key: "/rewards/analytics" },
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
  // Giveaway log — driven by `admin_giveaway_actions` rows that the
  // adjust-balance flow writes when the reason is tagged "Giveaway".
  // Same permission default as the rest of Marketing.
  { group: "Marketing", label: "Giveaway", key: "/marketing/giveaway" },
  // Employees — internal staff workflow (board + shift planning)
  { group: "Employees", label: "Employee Board", key: "/employees" },
  { group: "Employees", label: "Shifts", key: "/shifts" },
  // Creator Portal
  { group: "Creator Portal", label: "My Profile", key: "/my-profile" },
  // Creators
  { group: "Creators", label: "Creators", key: "/creators" },
  { group: "Creators", label: "Codes", key: "/creators/codes" },
  { group: "Creators", label: "Ads", key: "/creators/ads" },
  { group: "Creators", label: "Analytics", key: "/creators/analytics" },
  { group: "Creators", label: "Settings", key: "/creators/settings" },
  { group: "Creators", label: "Leaderboards", key: "/creators/leaderboards" },
  // Multiplier Review hidden from navigation — settlement is now automatic
  // at end-stream so the queue is always empty for new deals. Page still
  // exists at /creators/multiplier-review for clearing legacy stuck deals.
  // Moderation
  { group: "Moderation", label: "Chat", key: "/chat" },
  // Security
  { group: "Security", label: "Security", key: "/security" },
  // System
  { group: "System", label: "Users", key: "/admin-users" },
  { group: "System", label: "Roles", key: "/settings/roles" },
  { group: "System", label: "Bots", key: "/bots" },
  { group: "System", label: "Settings", key: "/settings" },
  { group: "System", label: "Audit Log", key: "/audit" },
  { group: "System", label: "Commands", key: "/system/commands" },
  { group: "System", label: "Dashboard Stats", key: "/system/stats" },
  // motha-only — the page + actions enforce the gate server-side;
  // listing here just makes the key known to the permission system
  // so it doesn't fall through as "unknown page".
  { group: "System", label: "Excluded Users", key: "/system/excluded-users" },
];

export const ALL_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);
