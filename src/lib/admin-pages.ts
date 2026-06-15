export type AdminPage = {
  group: string;
  label: string;
  key: string;
};

export const ADMIN_PAGES: AdminPage[] = [
  // Navigation
  { group: "Navigation", label: "Dashboard", key: "/dashboard" },
  { group: "Navigation", label: "Analytics", key: "/analytics" },
  { group: "Navigation", label: "Numbers", key: "/numbers" },
  { group: "Navigation", label: "Raw P&L", key: "/analytics/pure-pnl" },
  // GGR moved to the Insights group below.
  // /map was folded into /analytics as a tab — its permission inherits
  // from /analytics. The standalone page no longer exists.
  { group: "Navigation", label: "Users", key: "/users" },
  { group: "Navigation", label: "Creators", key: "/creators" },
  // XP Sales — global view of every xp_purchase (users buying XP with their
  // own withdrawable balance). House-POV revenue surface, customer-scoped.
  { group: "Navigation", label: "XP Sales", key: "/xp-sales" },
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
  // Real Numbers — the source-of-truth page, now the Insights LANDING
  // (sidebar label "Overview"). Reads the canonical corrected metric layer
  // (creators + staff + blacklist excluded; borrow-net basis) and shows the
  // reconciled lifetime headline (wager / GGR / reward cost / NGR / realized
  // P&L), a per-game GGR split, both the gaming-margin and balance-sheet
  // waterfalls, the GGR↔P&L reconciliation, and plain-language definitions.
  // The former standalone /insights hub page was removed; /insights now
  // 308-redirects here (next.config.ts). Own grantable key.
  { group: "Insights", label: "Overview (Real Numbers)", key: "/insights/real-numbers" },
  // Cost Breakdown — the full wager → P&L leakage waterfall (every cost
  // category itemized). Route is KEPT and reachable via a link on the
  // Insights Overview page, but it no longer has its own sidebar nav entry.
  // Active grantable key (the page still gates on it).
  { group: "Insights", label: "Cost Breakdown", key: "/insights/cost-breakdown" },
  { group: "Insights", label: "Rewards", key: "/insights/rewards" },
  // Legacy routes — thin redirects; keys retained for bookmark + role grants
  // so existing grants don't become "unknown". The pages were removed and
  // the routes 308-redirect to the Insights Overview (next.config.ts).
  { group: "Insights", label: "Insights Hub (legacy)", key: "/insights" },
  { group: "Insights", label: "Analytics (legacy)", key: "/insights/analytics" },
  { group: "Insights", label: "GGR (legacy)", key: "/ggr" },
  { group: "Insights", label: "Challenges insights (legacy)", key: "/insights/challenges" },
  { group: "Insights", label: "Edge Plan 2.0 (legacy)", key: "/insights/edge-plan-2" },
  { group: "Insights", label: "Wager Liability (legacy)", key: "/insights/wager-liability" },
  { group: "Insights", label: "Games (legacy)", key: "/insights/games" },
  { group: "Insights", label: "Signup (legacy)", key: "/insights/rewards/signup" },
  {
    group: "Insights",
    label: "Balance Adjustments (legacy)",
    key: "/insights/balance-adjustments",
  },
  // Per-reward-type deep-dives. Each is its own grantable permission key
  // so role grants can be managed independently from the parent overview
  // (an admin can be granted just the rakeback or affiliate breakdown
  // without the full Rewards rollup).
  { group: "Insights", label: "Deposit Bonus", key: "/insights/rewards/deposit-bonus" },
  { group: "Insights", label: "Rakeback", key: "/insights/rewards/rakeback" },
  { group: "Insights", label: "Reward Expiry", key: "/insights/rewards/expiry" },
  { group: "Insights", label: "Race", key: "/insights/rewards/race" },
  { group: "Insights", label: "Affiliate", key: "/insights/rewards/affiliate" },
  // Forecast — unified reward-forecast hub. Hosts a full-depth
  // scenario simulation per reward type (modeled on the deposit-bonus
  // forecast), anchored on real production baselines. Own permission
  // key so it can be granted independently of the per-reward deep-dives.
  { group: "Insights", label: "Forecast", key: "/insights/forecast" },
  // Transactions
  // Standalone /transactions overview removed — admins land on a
  // specific sub-ledger instead. Each sub-page carries its own
  // permission key.
  // The deposits/withdrawals ledger lives in the Overview nav group (it
  // was NOT part of the Transactions→Content merge); its picker group is
  // left unchanged.
  { group: "Transactions", label: "Transactions", key: "/transactions/deposits" },
  // Content
  { group: "Content", label: "Packs", key: "/packs" },
  // Shard packs — packs bought & opened with shards (a wager-earned
  // currency). Backed by MAIN `packs` rows with pack_type='shard'.
  { group: "Content", label: "Shard Packs", key: "/rewards/shards" },
  { group: "Content", label: "Cards", key: "/cards" },
  { group: "Content", label: "Sets", key: "/sets" },
  { group: "Content", label: "Upgrader", key: "/upgrader" },
  // Transaction surfaces merged into the Content nav group (commit
  // d28479f3 folded the standalone "Transactions" sidebar group into
  // Content). Mirror that here so the role-permissions picker lists them
  // under Content too — routes, pageKeys and permission boundaries are
  // unchanged; this is a display-grouping label only.
  { group: "Content", label: "Pack Transactions", key: "/transactions/packs" },
  { group: "Content", label: "Battles", key: "/battles" },
  { group: "Content", label: "Reward Transactions", key: "/transactions/rewards" },
  { group: "Content", label: "Upgrader Transactions", key: "/transactions/upgrader" },
  // Rewards
  { group: "Rewards", label: "Rewards", key: "/rewards" },
  { group: "Rewards", label: "Analytics", key: "/rewards/analytics" },
  { group: "Rewards", label: "Rakeback", key: "/rewards/rakeback" },
  // Shard Pack Opens — opens of shard-bought packs from the
  // `coin_transactions` ledger (shards spent + shards won per open). Own
  // grantable key so it can be granted independently of the shard-pack
  // CATALOG (/rewards/shards, in Content).
  { group: "Rewards", label: "Shard Pack Opens", key: "/rewards/shard-opens" },
  // Promo Codes — moved here from the Marketing group so the role
  // editor mirrors the sidebar grouping. Permission key is unchanged.
  { group: "Rewards", label: "Promo Codes", key: "/promo-codes" },
  { group: "Rewards", label: "Challenges", key: "/challenges" },
  { group: "Rewards", label: "Rain", key: "/rain" },
  { group: "Rewards", label: "Leaderboards", key: "/rewards/leaderboards" },
  { group: "Rewards", label: "Level Up", key: "/rewards/level-up" },
  // Giveaway log — driven by `admin_giveaway_actions` rows that the
  // adjust-balance flow writes when the reason is tagged "Giveaway".
  { group: "Rewards", label: "Giveaway", key: "/marketing/giveaway" },
  { group: "Rewards", label: "Affiliate Settings", key: "/creators/settings" },
  { group: "Rewards", label: "Settings", key: "/rewards/settings" },
  // Creator analytics — palette-only; no sidebar link. Ads and gift cards
  // were removed; bookmarks redirect to /creators and /rewards.
  { group: "Navigation", label: "Creator Analytics", key: "/creators/analytics" },
  // Creator leaderboards / changelog / socials review live in Creator Hub;
  // removed from the admin sidebar. Routes remain for bookmarks; grant via
  // /creators or admin role.
  // Employees — internal staff workflow (board + shift planning)
  { group: "Employees", label: "Employee Board", key: "/employees" },
  { group: "Employees", label: "Shifts", key: "/shifts" },
  // Creator Portal
  { group: "Creator Portal", label: "My Profile", key: "/my-profile" },
  // Multiplier review queue removed — settlement is automatic at end-stream.
  // Moderation
  { group: "Moderation", label: "Chat", key: "/chat" },
  // System
  { group: "System", label: "Security", key: "/security" },
  { group: "System", label: "Admins & Access", key: "/admin-users" },
  // The former "/settings/roles" page key was removed: Roles & Permissions is
  // now an ADMIN-ONLY tab of /admin-users, gated by requireAdmin (not a
  // grantable page key), so the key is vestigial. No role baseline references
  // it (verified), so removing it leaves no orphan token.
  // Geo Blocking — per-country deposit / withdrawal restrictions
  // (formerly the "Country Restrictions" section of the removed /settings
  // page). The page + actions enforce requireAdmin server-side; listed here
  // so the key is known to the permission system.
  { group: "System", label: "Geo Blocking", key: "/system/geo-blocking" },
  { group: "System", label: "Audit Log", key: "/audit" },
  // Monitor — health/overview of the standalone backend-monitor service
  // (a separate Railway app from the game backend). Read-only telemetry
  // surface fetched server-side from MONITOR_API_URL with a bearer token.
  { group: "System", label: "Monitor", key: "/system/monitor" },
  // motha-only — the page + actions enforce the gate server-side;
  // listing here just makes the key known to the permission system
  // so it doesn't fall through as "unknown page".
  { group: "System", label: "Excluded Users", key: "/system/excluded-users" },
];

export const ALL_PAGE_KEYS = ADMIN_PAGES.map((p) => p.key);

/** Retired routes whose DB permission keys still grant the replacement page. */
export const PAGE_ACCESS_ALIASES: Record<string, readonly string[]> = {
  "/insights/edge-plan-2": ["/insights/system-edge-plan"],
};

export function pageAccessGranted(
  allowedPages: string[],
  pageKey: string,
): boolean {
  if (allowedPages.includes(pageKey)) return true;
  const aliases = PAGE_ACCESS_ALIASES[pageKey];
  return aliases?.some((legacy) => allowedPages.includes(legacy)) ?? false;
}
