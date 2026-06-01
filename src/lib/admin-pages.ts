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
  // GGR moved to the Insights group below.
  // Changelogs — curated admin-internal release notes. Page is read-
  // only for anyone with /changelogs access; publish/edit/delete are
  // additionally gated by __can_manage_changelog (defined in
  // settings/roles/permissions-utils.ts).
  { group: "Navigation", label: "Changelogs", key: "/changelogs" },
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
  // Insights — cross-cutting analytical surfaces. Mirrors the sidebar
  // group sitting directly below Overview. Separate from the per-feature
  // analytics keys (e.g. /rewards/analytics) so role grants can be
  // managed independently.
  { group: "Insights", label: "Analytics", key: "/insights/analytics" },
  // GGR — long-form GGR breakdown page (24h/3d/7d windows, per-type
  // cards, top-10 contributors). Sits in Insights alongside the other
  // cross-cutting analytical surfaces.
  { group: "Insights", label: "GGR", key: "/ggr" },
  { group: "Insights", label: "Games", key: "/insights/games" },
  { group: "Insights", label: "Rewards", key: "/insights/rewards" },
  { group: "Insights", label: "Streamers", key: "/insights/streamers" },
  // Edge Calc — theoretical EV / RTP / house-edge math + scenario
  // simulator. Pure-math companion to the empirical /insights/games
  // page so admins can model packs / upgrader / bonus stacks before
  // they ship a change.
  { group: "Insights", label: "Edge Calc", key: "/insights/edge-calc" },
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
  // Promo Codes — moved here from the Marketing group so the role
  // editor mirrors the sidebar grouping. Permission key is unchanged.
  { group: "Rewards", label: "Promo Codes", key: "/promo-codes" },
  { group: "Rewards", label: "Raffles", key: "/rewards/raffles" },
  { group: "Rewards", label: "Rain", key: "/rain" },
  { group: "Rewards", label: "Leaderboards", key: "/rewards/leaderboards" },
  { group: "Rewards", label: "Level Up", key: "/rewards/level-up" },
  { group: "Rewards", label: "Settings", key: "/rewards/settings" },
  // Marketing — campaign tools + acquisition surfaces. Mirrors the
  // sidebar's Marketing group so an admin who can grant items in
  // the role editor sees them under the same banner the user clicks
  // through in the sidebar. Analytics stays grouped here as a
  // permission key (admins can still grant /creators/analytics) but
  // its sidebar link was dropped per the nav split. Codes and
  // Vouchers were removed from both nav and the role editor — the
  // routes (/creators/codes, /vouchers) remain reachable by URL but
  // are no longer surfaced or grantable as separate permissions.
  { group: "Marketing", label: "Ads", key: "/creators/ads" },
  { group: "Marketing", label: "Analytics", key: "/creators/analytics" },
  { group: "Marketing", label: "Settings", key: "/creators/settings" },
  // Promo Codes was moved to the Rewards group (mirrors the sidebar).
  { group: "Marketing", label: "Gift Cards", key: "/gift-cards" },
  // Giveaway log — driven by `admin_giveaway_actions` rows that the
  // adjust-balance flow writes when the reason is tagged "Giveaway".
  // Same permission default as the rest of Marketing.
  { group: "Marketing", label: "Giveaway", key: "/marketing/giveaway" },
  // Creator Marketing — the "who promotes us" half of the old
  // Creators group. Mirrors the new sidebar group of the same name
  // so the role editor lines up with what admins actually navigate
  // to. Socials Review piggybacks on the `/creators` permission key
  // (no separate entry) — granting Creators access lets the user
  // see the socials review page too.
  { group: "Creator Marketing", label: "Creators", key: "/creators" },
  { group: "Creator Marketing", label: "Leaderboards", key: "/creators/leaderboards" },
  // Employees — internal staff workflow (board + shift planning)
  { group: "Employees", label: "Employee Board", key: "/employees" },
  { group: "Employees", label: "Shifts", key: "/shifts" },
  // Creator Portal
  { group: "Creator Portal", label: "My Profile", key: "/my-profile" },
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
