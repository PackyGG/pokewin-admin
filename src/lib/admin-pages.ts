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
  // /map was folded into /analytics as a tab — its permission inherits
  // from /analytics. The standalone page no longer exists.
  { group: "Navigation", label: "Users", key: "/users" },
  // Gates the new VIPs page (Players sidebar section, lists users tagged vip).
  { group: "Navigation", label: "VIPs", key: "/vips" },
  // Top Chatters (Players sidebar section) — live leaderboard of the most
  // active packy chat senders for the current UTC calendar day.
  { group: "Navigation", label: "Top Chatters", key: "/top-chatters" },
  // Player CRM was folded into the owner-only Insights Overview as a tab
  // (/insights/real-numbers?tab=crm); /crm now 308-redirects there and its
  // permission inherits from /insights/real-numbers, so the standalone /crm
  // page key was retired (mirrors how /map dropped its key into /analytics).
  { group: "Navigation", label: "Creators", key: "/creators" },
  // XP Sales was merged into the /rewards tab hub (XP Sales tab); the page
  // now gates on /rewards, so the standalone /xp-sales key was retired. The
  // ClickHouse twin + insights-xp-sales data layer are unaffected.
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
  // Insights Overview — a tabbed page: Real Numbers (the landing tab, the
  // source-of-truth headline) + Analytics (deposit cadence & platform
  // analytics, demoted to a tab) + Player CRM. Sidebar label "Real Numbers".
  // Reads the canonical corrected metric layer (creators + staff + blacklist
  // excluded; borrow-net basis) and shows the reconciled lifetime headline
  // (wager / GGR / reward cost / NGR / realized P&L), a per-game GGR split,
  // both the gaming-margin and balance-sheet waterfalls, the GGR↔P&L
  // reconciliation, and plain-language definitions. The former standalone
  // /insights hub page was removed; /insights now 308-redirects here
  // (next.config.ts). Own grantable key (route + permission unchanged).
  { group: "Insights", label: "Real Numbers (Analytics)", key: "/insights/real-numbers" },
  // Cost Breakdown — the full wager → P&L leakage waterfall (every cost
  // category itemized). Route is KEPT and reachable via a link on the
  // Insights Overview page, but it no longer has its own sidebar nav entry.
  // Active grantable key (the page still gates on it).
  { group: "Insights", label: "Cost Breakdown", key: "/insights/cost-breakdown" },
  { group: "Insights", label: "Rewards", key: "/insights/rewards" },
  // Affiliate Codes lookup page (/insights/affiliate-codes) was removed as a
  // standalone admin surface (2026-07); the page key was retired. The
  // affiliate code data model and the /insights/rewards?tab=affiliate
  // analytics tab are unaffected.
  // Double Down — read-only tracking of the gamble-your-battle-winnings
  // feature: global House-POV KPI strip + the full round-by-round audit log
  // (who won / lost, staked, paid out, house cut). Own grantable key so it
  // can be managed independently of the rewards rollup; the whole /insights
  // tree is additionally owner-gated.
  { group: "Insights", label: "Double Down", key: "/insights/double-down" },
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
  // Shard Packs (/rewards/shards) — the shard-pack system was disabled at
  // the backend/DB level by the owner (2026-07) and the dedicated admin
  // surface was removed; the page key was retired.
  { group: "Content", label: "Cards", key: "/cards" },
  { group: "Content", label: "Sets", key: "/sets" },
  { group: "Content", label: "Upgrader", key: "/upgrader" },
  // Transaction surfaces merged into the Content nav group (commit
  // d28479f3 folded the standalone "Transactions" sidebar group into
  // Content). Mirror that here so the role-permissions picker lists them
  // under Content too — routes, pageKeys and permission boundaries are
  // unchanged; this is a display-grouping label only.
  { group: "Content", label: "Pack Transactions", key: "/transactions/packs" },
  // Battles admin page (/battles) was removed as a standalone admin surface
  // (2026-07); the page key was retired. Battle data itself is untouched and
  // still shown elsewhere (user-detail history, dashboard KPIs, creators
  // pages, insights-games).
  { group: "Content", label: "Upgrader Transactions", key: "/transactions/upgrader" },
  // Rewards
  { group: "Rewards", label: "Rewards", key: "/rewards" },
  // Deposit Bonus was merged into the /rewards tab hub (Deposit Bonus tab);
  // the page now gates on /rewards, so the standalone /rewards/deposit-bonus
  // key was retired. The /insights/rewards/deposit-bonus deep-dive keeps its
  // own key.
  { group: "Rewards", label: "Analytics", key: "/rewards/analytics" },
  // Rakeback was merged into the /rewards tab hub (Rakeback tab); the page
  // now gates on /rewards, so the standalone /rewards/rakeback key was
  // retired. The /insights/rewards/rakeback deep-dive keeps its own key.
  // Promo Codes list was merged into the /rewards tab hub (Promo Codes tab),
  // but the /promo-codes KEY is retained — the /promo-codes/[id] detail route
  // still gates on it (requirePageAccess("/promo-codes")). Only the
  // sidebar/palette nav entry for the standalone list was removed.
  { group: "Rewards", label: "Promo Codes", key: "/promo-codes" },
  // The standalone /challenges CRUD page was merged into /rewards as its
  // "Challenges" tab (the page now gates on /rewards); its own key was
  // retired. Legacy /insights/challenges keeps its separate key below.
  // Rain list was also merged into /rewards (its "Rain" tab), but the
  // /rain KEY is retained — the /rain/[id] detail route still gates on it
  // (requirePageAccess("/rain")). Only the sidebar/palette nav entry for the
  // standalone list was removed.
  { group: "Rewards", label: "Rain", key: "/rain" },
  // Leaderboards was merged into the /rewards tab hub (Leaderboards tab);
  // the page now gates on /rewards, so the standalone /rewards/leaderboards
  // key was retired. Its write actions gate on requireAdmin (not a page key),
  // so no orphaned grant token remains.
  // Level Up + Reward Settings were merged into the /rewards tab hub (Level Up
  // and Settings tabs); both pages now gate on /rewards, so the standalone
  // /rewards/level-up and /rewards/settings keys were retired.
  // Affiliate config surfaces as the /rewards Affiliate tab, but the
  // /creators/settings ROUTE + KEY are RETAINED: the standalone route still
  // exists and its server actions (affiliate-claims-wager-requirement-actions,
  // creators/actions, security/wager-requirement-actions) still gate /
  // revalidate on "/creators/settings". Only the Rewards nav entry was removed.
  { group: "Creators", label: "Affiliate Settings", key: "/creators/settings" },
  // Creator analytics — palette-only; no sidebar link. Ads and gift cards
  // were removed; bookmarks redirect to /creators and /rewards.
  { group: "Navigation", label: "Creator Analytics", key: "/creators/analytics" },
  // Shifts page + the Employees sidebar section were removed. The /shifts KEY
  // is RETAINED as legacy: 8 live support users carry it in their stored
  // allowed_pages (pinned by the CI parity harness parity-fixture.json) and
  // sanitizePermissionKeys drops unknown keys — dropping it here would rewrite
  // those users' effective access and break the parity test. Mirrors the
  // /withdrawals + /ggr "keys retained so existing grants don't become
  // unknown" pattern above. The route itself is gone (404s), so the grant is
  // now inert.
  { group: "System", label: "Shifts (legacy)", key: "/shifts" },
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
