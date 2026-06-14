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
  // Insights Hub — the /insights landing page (a headline KPI strip
  // sourced from the canonical cost-breakdown helper plus quick-link
  // cards into every sub-area). Sits first so an admin granted only the
  // hub can navigate into deeper sub-grants from there.
  { group: "Insights", label: "Insights Hub", key: "/insights" },
  // Cost Breakdown — the full wager → P&L leakage waterfall (every cost
  // category itemized so the gap between gross wager and realized P&L is
  // fully accounted for). First entry in the group; it's the headline
  // "where does the money go" surface that sits on top of GGR / Money
  // Flow / Rewards.
  { group: "Insights", label: "Cost Breakdown", key: "/insights/cost-breakdown" },
  // Real Numbers — the source-of-truth page. Reads the canonical corrected
  // metric layer (creators + staff + blacklist excluded; borrow-net basis)
  // and shows the reconciled lifetime headline (wager / GGR / reward cost /
  // NGR / realized P&L), a per-game GGR split, both the gaming-margin and
  // balance-sheet waterfalls, the GGR↔P&L reconciliation, and plain-language
  // definitions. Own grantable key so a role can be granted it independently.
  { group: "Insights", label: "Real Numbers", key: "/insights/real-numbers" },
  { group: "Insights", label: "Analytics", key: "/insights/analytics" },
  // GGR — long-form GGR breakdown page (24h/3d/7d windows, per-type
  // cards, top-10 contributors). Sits in Insights alongside the other
  // cross-cutting analytical surfaces.
  { group: "Insights", label: "GGR", key: "/ggr" },
  { group: "Insights", label: "Rewards", key: "/insights/rewards" },
  // Challenges — analytics surface for the challenge program (prize cost,
  // claims, completion). The /challenges page stays CRUD-only; this is the
  // read-only insights view. Own grantable key.
  { group: "Insights", label: "Challenges", key: "/insights/challenges" },
  // Legacy routes — thin redirects; keys retained for bookmark + role grants.
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
  { group: "Insights", label: "Edge Plan 2.0", key: "/insights/edge-plan-2" },
  // Wager Liability — platform-wide wager-requirement liability snapshot
  // (gated user balances behind the sweepstakes wager requirement). Own
  // grantable key so a role can be granted it independently.
  { group: "Insights", label: "Wager Liability", key: "/insights/wager-liability" },
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
  // Shard packs — packs bought & opened with shards (a wager-earned
  // currency). Backed by MAIN `packs` rows with pack_type='shard'.
  { group: "Content", label: "Shard Packs", key: "/rewards/shards" },
  { group: "Content", label: "Cards", key: "/cards" },
  { group: "Content", label: "Sets", key: "/sets" },
  { group: "Content", label: "Upgrader", key: "/upgrader" },
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
  { group: "System", label: "Users", key: "/admin-users" },
  { group: "System", label: "Roles", key: "/settings/roles" },
  { group: "System", label: "Settings", key: "/settings" },
  { group: "System", label: "Audit Log", key: "/audit" },
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
