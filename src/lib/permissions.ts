// Source of truth for granular capabilities used by the custom-roles system.
//
// This file is ADDITIVE infrastructure: it does NOT replace the existing
// `__`-prefixed capability keys stored on admin_users.allowed_pages (see
// src/app/(admin)/settings/roles/permissions-utils.ts). Both systems coexist
// during the transition from hardcoded roles → custom admin_roles rows.
//
// Capability format: `domain.action` (e.g. `balances.adjust`, `users.ban`).
// Every mutating server action / API route in src/app/(admin) has a
// corresponding key here so a role can grant it individually.
//
// Page keys use the `pages.` prefix and map 1:1 to entries in
// src/lib/admin-pages.ts (ADMIN_PAGES). They're kept alongside capabilities
// so a single `capabilities: string[]` column on admin_roles can carry both.
//
// Adding a new capability:
//   1. Add it to CAPABILITIES below, under the correct domain.
//   2. Pick a stable key (`domain.action`) — keys are persisted in the DB.
//   3. Add a label + description (shown in the role editor UI).
//   4. DO NOT remove keys without a migration plan — roles may reference them.

export type CapabilityDef = {
  key: string;
  label: string;
  description: string;
};

export type CapabilityDomain = {
  domain: string;
  label: string;
  description?: string;
  capabilities: CapabilityDef[];
};

// ---------------------------------------------------------------------------
// Full catalog, grouped by domain.
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  // ── Page access ────────────────────────────────────────────────────────
  // Mirrors src/lib/admin-pages.ts. Keys use the `pages.` prefix so they
  // live in the same array as action capabilities.
  {
    domain: "pages",
    label: "Page Access",
    description: "Which sidebar pages a role can open.",
    capabilities: [
      { key: "pages.dashboard", label: "Dashboard", description: "View the main dashboard." },
      { key: "pages.analytics", label: "Analytics", description: "View analytics reports." },
      { key: "pages.map", label: "Map", description: "View the user geo map." },
      { key: "pages.users", label: "Users", description: "Browse end-users of the platform." },
      { key: "pages.withdrawals", label: "Withdrawals", description: "View the withdrawals queue." },
      { key: "pages.transactions", label: "Transactions (All)", description: "View all transactions." },
      { key: "pages.transactions_packs", label: "Pack Transactions", description: "View pack opening transactions." },
      { key: "pages.transactions_battles", label: "Battle Transactions", description: "View battle transactions." },
      { key: "pages.transactions_rewards", label: "Reward Transactions", description: "View reward transactions." },
      { key: "pages.transactions_deposits", label: "Deposits & Withdrawals", description: "View deposit + withdrawal ledger." },
      { key: "pages.packs", label: "Packs", description: "View and manage packs." },
      { key: "pages.cards", label: "Cards", description: "View and manage cards." },
      { key: "pages.battles", label: "Battles", description: "View and manage battles." },
      { key: "pages.rewards", label: "Rewards", description: "View rewards overview." },
      { key: "pages.rewards_rakeback", label: "Rakeback", description: "Configure rakeback." },
      { key: "pages.rewards_raffles", label: "Raffles", description: "View and manage raffles." },
      { key: "pages.rewards_leaderboards", label: "Leaderboards", description: "Configure leaderboards / races." },
      { key: "pages.rewards_level_up", label: "Level Up", description: "Configure level-up rewards." },
      { key: "pages.rewards_settings", label: "Reward Settings", description: "Adjust reward system settings." },
      { key: "pages.rain", label: "Rain", description: "View and run rain events." },
      { key: "pages.promo_codes", label: "Promo Codes", description: "Manage promo codes." },
      { key: "pages.gift_cards", label: "Gift Cards", description: "Manage gift cards." },
      { key: "pages.vouchers", label: "Vouchers", description: "Manage vouchers." },
      { key: "pages.spending", label: "Spending", description: "Track expenses and recurring costs." },
      { key: "pages.my_profile", label: "My Profile (Creator)", description: "Creator self-service profile." },
      { key: "pages.creators", label: "Creators", description: "Browse creators." },
      { key: "pages.creators_codes", label: "Creator Codes", description: "Browse affiliate / creator codes." },
      { key: "pages.creators_analytics", label: "Creator Analytics", description: "View creator performance." },
      { key: "pages.creators_settings", label: "Creator Settings", description: "Global creator settings." },
      { key: "pages.creators_leaderboards", label: "Affiliate Leaderboards", description: "Review, approve, and manage creator-submitted affiliate leaderboards." },
      { key: "pages.ads", label: "Ads", description: "Access the ads / generic codes page." },
      { key: "pages.chat", label: "Chat Moderation", description: "View and moderate chat." },
      { key: "pages.security", label: "Security", description: "Site security config." },
      { key: "pages.admin_users", label: "Admin Users", description: "Manage admin panel users." },
      { key: "pages.admin_roles", label: "Admin Roles", description: "Manage custom roles + permissions." },
      { key: "pages.settings_roles", label: "Legacy Role Permissions", description: "Legacy role-permissions page at /settings/roles." },
      { key: "pages.bots", label: "Bots", description: "Manage chat bots." },
      { key: "pages.settings", label: "Settings", description: "Global admin settings." },
      { key: "pages.audit", label: "Audit Log", description: "View the admin audit log." },
      { key: "pages.commands", label: "Commands", description: "View the command palette documentation." },
      { key: "pages.dashboard_stats", label: "Dashboard Stats", description: "View admin-panel health, query timings, and audit activity." },
    ],
  },

  // ── Users (end-users on the main platform) ─────────────────────────────
  {
    domain: "users",
    label: "Users",
    description: "Actions on end-user accounts of the main platform.",
    capabilities: [
      { key: "users.ban", label: "Ban user", description: "Ban a user (prevents login, invalidates sessions)." },
      { key: "users.unban", label: "Unban user", description: "Lift an existing ban." },
      { key: "users.lock", label: "Lock account", description: "Temporarily lock a user account." },
      { key: "users.unlock", label: "Unlock account", description: "Unlock a previously locked account." },
      { key: "users.delete", label: "Delete user", description: "Permanently delete a user (requires 2FA)." },
      { key: "users.bulk_delete", label: "Bulk delete users", description: "Delete up to 100 users at once (requires 2FA)." },
      { key: "users.wipe", label: "Wipe user data", description: "Irreversibly wipe all data for a user account." },
      { key: "users.edit_identity", label: "Edit user identity", description: "Change email, username, or display name." },
      { key: "users.toggle_feature_lock", label: "Toggle feature locks", description: "Lock/unlock deposits, withdrawals, exchanges, openings, vault." },
      { key: "users.change_role", label: "Change user role", description: "Change a user's platform role (user / creator / admin)." },
      { key: "users.update_withdrawal_limits", label: "Update withdrawal limits", description: "Set per-user withdrawal limits." },
    ],
  },

  // ── Balances / XP ──────────────────────────────────────────────────────
  {
    domain: "balances",
    label: "Balances & XP",
    description: "Ledger adjustments to user balances and XP.",
    capabilities: [
      { key: "balances.adjust", label: "Adjust balance", description: "Add or subtract balance from a user (ledger tracked; subject to balance limits)." },
      { key: "balances.adjust_xp", label: "Adjust XP", description: "Add or subtract XP from a user." },
    ],
  },

  // ── Admin notes ────────────────────────────────────────────────────────
  {
    domain: "notes",
    label: "Admin Notes",
    description: "Internal notes on user profiles.",
    capabilities: [
      { key: "notes.create", label: "Create note", description: "Add an internal note to a user profile." },
      { key: "notes.delete", label: "Delete note", description: "Delete an existing internal note." },
    ],
  },

  // ── Withdrawals ────────────────────────────────────────────────────────
  {
    domain: "withdrawals",
    label: "Withdrawals",
    description: "Withdrawal queue processing.",
    capabilities: [
      { key: "withdrawals.process", label: "Mark processing", description: "Move a pending withdrawal into processing." },
      { key: "withdrawals.ship", label: "Ship withdrawal", description: "Mark a withdrawal as shipped (with tracking)." },
      { key: "withdrawals.complete", label: "Complete withdrawal", description: "Mark a withdrawal as delivered." },
      { key: "withdrawals.cancel", label: "Cancel withdrawal", description: "Cancel a pending/processing withdrawal and refund balance." },
      { key: "withdrawals.fail", label: "Fail withdrawal", description: "Mark a withdrawal as failed." },
    ],
  },

  // ── Chat moderation ────────────────────────────────────────────────────
  {
    domain: "chat",
    label: "Chat",
    description: "Chat moderation actions.",
    capabilities: [
      { key: "chat.delete_message", label: "Delete message", description: "Remove a chat message." },
      { key: "chat.pin_message", label: "Pin message", description: "Pin a chat message." },
      { key: "chat.unpin_message", label: "Unpin message", description: "Unpin a chat message." },
      { key: "chat.mute_user", label: "Mute user", description: "Mute a user in chat (temp or permanent)." },
      { key: "chat.unmute_user", label: "Unmute user", description: "Lift an existing chat mute." },
    ],
  },

  // ── Packs ──────────────────────────────────────────────────────────────
  {
    domain: "packs",
    label: "Packs",
    description: "Pack definitions and availability.",
    capabilities: [
      { key: "packs.create", label: "Create pack", description: "Create a new pack." },
      { key: "packs.update", label: "Update pack", description: "Edit pack details and card pool." },
      { key: "packs.delete", label: "Delete pack", description: "Delete a pack." },
      { key: "packs.toggle_active", label: "Activate / deactivate pack", description: "Toggle whether a pack is purchasable." },
      { key: "packs.upload_image", label: "Upload pack image", description: "Upload a pack cover image." },
    ],
  },

  // ── Cards ──────────────────────────────────────────────────────────────
  {
    domain: "cards",
    label: "Cards",
    description: "Card catalog.",
    capabilities: [
      { key: "cards.create", label: "Create card", description: "Add a new card to the catalog." },
      { key: "cards.update", label: "Update card", description: "Edit card details." },
      { key: "cards.delete", label: "Delete card", description: "Remove a card from the catalog." },
      { key: "cards.upload_image", label: "Upload card image", description: "Upload a card image." },
    ],
  },

  // ── Battles ────────────────────────────────────────────────────────────
  {
    domain: "battles",
    label: "Battles",
    description: "Pack battle moderation.",
    capabilities: [
      { key: "battles.cancel", label: "Cancel battle", description: "Cancel an in-progress battle and refund players." },
    ],
  },

  // ── Rewards / rakeback ─────────────────────────────────────────────────
  {
    domain: "rewards",
    label: "Rewards",
    description: "Reward definitions, rakeback, and reload.",
    capabilities: [
      { key: "rewards.create", label: "Create reward", description: "Create a reward." },
      { key: "rewards.update", label: "Update reward", description: "Edit an existing reward." },
      { key: "rewards.delete", label: "Delete reward", description: "Delete a reward." },
      { key: "rewards.reload_packs", label: "Reload reward packs", description: "Refresh the reward pack cache." },
      { key: "rewards.update_rakeback", label: "Update rakeback config", description: "Change rakeback tier configuration." },
    ],
  },

  // ── Raffles ────────────────────────────────────────────────────────────
  {
    domain: "raffles",
    label: "Raffles",
    description: "Raffle creation and moderation.",
    capabilities: [
      { key: "raffles.create", label: "Create raffle", description: "Create a new raffle." },
      { key: "raffles.update", label: "Update raffle", description: "Edit an existing raffle." },
      { key: "raffles.cancel", label: "Cancel raffle", description: "Cancel a raffle and refund participants." },
    ],
  },

  // ── Leaderboards / races ───────────────────────────────────────────────
  {
    domain: "leaderboards",
    label: "Leaderboards",
    description: "Leaderboard / race prize configuration.",
    capabilities: [
      { key: "leaderboards.upsert_prize_tier", label: "Upsert prize tier", description: "Create or update a race prize tier." },
      { key: "leaderboards.delete_prize_tier", label: "Delete prize tier", description: "Remove a race prize tier." },
    ],
  },

  // ── Rain ───────────────────────────────────────────────────────────────
  {
    domain: "rain",
    label: "Rain",
    description: "Rain event controls.",
    capabilities: [
      { key: "rain.adjust_base", label: "Adjust rain base", description: "Change the base amount for an active rain." },
      { key: "rain.update_config", label: "Update rain config", description: "Edit rain configuration." },
    ],
  },

  // ── Promo codes ────────────────────────────────────────────────────────
  {
    domain: "promo_codes",
    label: "Promo Codes",
    description: "Promo code creation and deletion.",
    capabilities: [
      { key: "promo_codes.create", label: "Create promo code", description: "Issue a new promo code." },
      { key: "promo_codes.delete", label: "Delete promo code", description: "Delete a promo code." },
      { key: "promo_codes.view_redemptions", label: "View redemptions", description: "List redemptions for a promo code." },
    ],
  },

  // ── Gift cards ─────────────────────────────────────────────────────────
  {
    domain: "gift_cards",
    label: "Gift Cards",
    description: "Gift card lifecycle.",
    capabilities: [
      { key: "gift_cards.create", label: "Create gift card", description: "Generate a new gift card." },
      { key: "gift_cards.cancel", label: "Cancel gift card", description: "Cancel an issued gift card." },
    ],
  },

  // ── Vouchers ───────────────────────────────────────────────────────────
  {
    domain: "vouchers",
    label: "Vouchers",
    description: "Voucher creation.",
    capabilities: [
      { key: "vouchers.create", label: "Create voucher", description: "Issue a voucher to a user." },
    ],
  },

  // ── Affiliate / creator codes ──────────────────────────────────────────
  {
    domain: "affiliate_codes",
    label: "Affiliate Codes",
    description: "Affiliate code assignment.",
    capabilities: [
      { key: "affiliate_codes.create", label: "Create affiliate code", description: "Create a new affiliate code for a user." },
      { key: "affiliate_codes.assign", label: "Assign affiliate code", description: "Assign an affiliate code to a user (their referrer)." },
      { key: "affiliate_codes.toggle_active", label: "Toggle affiliate code", description: "Enable / disable an affiliate code." },
      { key: "affiliate_codes.remove", label: "Remove affiliate code", description: "Remove an affiliate code." },
    ],
  },

  // ── Creators ───────────────────────────────────────────────────────────
  {
    domain: "creators",
    label: "Creators",
    description: "Creator accounts, deals, payouts, socials.",
    capabilities: [
      { key: "creators.make_creator", label: "Promote to creator", description: "Flag a user as a creator." },
      { key: "creators.update_affiliate_level", label: "Update affiliate level", description: "Change a creator's affiliate level." },
      { key: "creators.update_limits", label: "Update creator limits", description: "Edit a creator's withdrawal / tip limits." },
      { key: "creators.approve_payout", label: "Approve / process payout", description: "Process a creator payout." },
      { key: "creators.update_level_config", label: "Update level config", description: "Change global affiliate level config." },
      { key: "creators.update_cut_expiration", label: "Update cut expiration", description: "Set when an affiliate cut expires." },
      { key: "creators.toggle_code_active", label: "Toggle creator code", description: "Enable / disable a creator's affiliate code." },
      { key: "creators.create_webhook", label: "Create webhook", description: "Add a creator webhook." },
      { key: "creators.update_webhook", label: "Update webhook", description: "Edit an existing creator webhook." },
      { key: "creators.delete_webhook", label: "Delete webhook", description: "Remove a creator webhook." },
      { key: "creators.test_webhook", label: "Test webhook", description: "Fire a test delivery to a webhook." },
      { key: "creators.link_social", label: "Link creator social", description: "Link a social account to a creator." },
      { key: "creators.unlink_social", label: "Unlink creator social", description: "Remove a creator's social link." },
      { key: "creators.create_deal", label: "Create deal", description: "Create a creator deal." },
      { key: "creators.update_deal", label: "Update deal", description: "Edit a creator deal." },
      { key: "creators.delete_deal", label: "Delete deal", description: "Remove a creator deal." },
      { key: "creators.manual_fill", label: "Manual balance fill", description: "Trigger a manual balance fill for a creator." },
      { key: "creators.link_main_user", label: "Link to main user", description: "Link a creator admin user to a main-site user." },
    ],
  },

  // ── Ads (generic / house-account campaign codes) ───────────────────────
  {
    domain: "ads",
    label: "Ads",
    description: "Campaign tracking codes.",
    capabilities: [
      { key: "ads.set_house_account", label: "Set house account", description: "Configure the account used for ad codes." },
      { key: "ads.create_code", label: "Create ad code", description: "Create a new ad tracking code." },
      { key: "ads.delete_code", label: "Delete ad code", description: "Delete an ad tracking code." },
    ],
  },

  // ── Creator self-service (the /my-profile page) ────────────────────────
  {
    domain: "my_profile",
    label: "My Profile (Creator Self-Service)",
    description: "Actions a creator can take on their own profile.",
    capabilities: [
      { key: "my_profile.create_webhook", label: "Create own webhook", description: "Creator adds their own webhook." },
      { key: "my_profile.update_webhook", label: "Update own webhook", description: "Creator edits their own webhook." },
      { key: "my_profile.delete_webhook", label: "Delete own webhook", description: "Creator removes their own webhook." },
      { key: "my_profile.test_webhook", label: "Test own webhook", description: "Creator tests their own webhook." },
      { key: "my_profile.link_social", label: "Link own social", description: "Creator links their own social account." },
      { key: "my_profile.unlink_social", label: "Unlink own social", description: "Creator unlinks their own social account." },
    ],
  },

  // ── Spending / expenses ────────────────────────────────────────────────
  {
    domain: "spending",
    label: "Spending",
    description: "Expense tracking.",
    capabilities: [
      { key: "spending.create_expense", label: "Create expense", description: "Log a one-off expense." },
      { key: "spending.update_expense", label: "Update expense", description: "Edit an expense." },
      { key: "spending.delete_expense", label: "Delete expense", description: "Remove an expense." },
      { key: "spending.create_recurring", label: "Create recurring", description: "Add a recurring expense." },
      { key: "spending.update_recurring", label: "Update recurring", description: "Edit a recurring expense." },
      { key: "spending.toggle_recurring", label: "Toggle recurring", description: "Enable / disable a recurring expense." },
      { key: "spending.delete_recurring", label: "Delete recurring", description: "Remove a recurring expense." },
    ],
  },

  // ── Bots ───────────────────────────────────────────────────────────────
  {
    domain: "bots",
    label: "Bots",
    description: "Chat bot configuration.",
    capabilities: [
      { key: "bots.create", label: "Create bot", description: "Add a chat bot." },
      { key: "bots.update", label: "Update bot", description: "Edit a chat bot." },
      { key: "bots.toggle_active", label: "Toggle bot active", description: "Enable / disable a chat bot." },
    ],
  },

  // ── Security (site config) ─────────────────────────────────────────────
  {
    domain: "security",
    label: "Security",
    description: "Site-wide security configuration.",
    capabilities: [
      { key: "security.upsert_site_config", label: "Upsert site config", description: "Create or update a site_config entry." },
      { key: "security.delete_site_config", label: "Delete site config", description: "Remove a site_config entry." },
    ],
  },

  // ── Settings ───────────────────────────────────────────────────────────
  {
    domain: "settings",
    label: "Settings",
    description: "Global admin settings (vault lock, country restrictions, legacy role permissions).",
    capabilities: [
      { key: "settings.upsert_vault_lock", label: "Upsert vault lock time", description: "Configure vault lock windows." },
      { key: "settings.delete_vault_lock", label: "Delete vault lock", description: "Remove a vault lock window." },
      { key: "settings.update_country_restriction", label: "Update country restriction", description: "Edit the country restriction list." },
      { key: "settings.toggle_country_restriction", label: "Toggle country restriction", description: "Enable / disable the country block list." },
      { key: "settings.update_role_permissions", label: "Legacy: update role permissions", description: "Legacy hardcoded-role permissions editor at /settings/roles." },
    ],
  },

  // ── Admin users (the admin panel itself) ───────────────────────────────
  {
    domain: "admin_users",
    label: "Admin Users",
    description: "Manage admin-panel users.",
    capabilities: [
      { key: "admin_users.create", label: "Create admin user", description: "Create a new admin-panel user." },
      { key: "admin_users.toggle_active", label: "Activate / deactivate admin", description: "Enable or disable an admin account." },
      { key: "admin_users.reset_2fa", label: "Reset 2FA", description: "Force a 2FA reset for an admin user." },
      { key: "admin_users.change_role", label: "Change admin role", description: "Change an admin user's role (requires 2FA)." },
      { key: "admin_users.delete", label: "Delete admin user", description: "Permanently delete an admin-panel user." },
      { key: "admin_users.force_expire_sessions", label: "Force expire sessions", description: "Invalidate all active sessions of an admin." },
      { key: "admin_users.update_permissions", label: "Update admin permissions", description: "Change allowed_pages for a non-admin admin user." },
    ],
  },

  // ── Admin roles (the new custom-roles system) ──────────────────────────
  {
    domain: "admin_roles",
    label: "Admin Roles",
    description: "Manage custom roles (only real admins should ever have these).",
    capabilities: [
      { key: "admin_roles.create", label: "Create role", description: "Define a new custom role." },
      { key: "admin_roles.update", label: "Update role", description: "Edit a custom role's name / capabilities." },
      { key: "admin_roles.delete", label: "Delete role", description: "Delete a custom role (not assigned to any user)." },
      { key: "admin_roles.assign", label: "Assign role to admin user", description: "Set an admin user's role_id." },
    ],
  },
] as const satisfies readonly CapabilityDomain[];

// ---------------------------------------------------------------------------
// Derived types + helpers
// ---------------------------------------------------------------------------

type CapabilityFrom<T extends readonly CapabilityDomain[]> =
  T[number]["capabilities"][number]["key"];

/** Union of every capability key in the catalog. */
export type CapabilityKey = CapabilityFrom<typeof CAPABILITIES>;

/** Union of page keys (those starting with `pages.`). */
export type PageKey = Extract<CapabilityKey, `pages.${string}`>;

/** Flat list of all capability keys. */
export const ALL_CAPABILITY_KEYS: readonly CapabilityKey[] = CAPABILITIES.flatMap(
  (d) => d.capabilities.map((c) => c.key as CapabilityKey),
);

/** Flat list of all page keys. */
export const ALL_PAGE_CAPABILITY_KEYS: readonly PageKey[] = ALL_CAPABILITY_KEYS.filter(
  (k): k is PageKey => k.startsWith("pages."),
);

/** Every non-page capability key (action capabilities only). */
export const ALL_ACTION_CAPABILITY_KEYS: readonly CapabilityKey[] =
  ALL_CAPABILITY_KEYS.filter((k) => !k.startsWith("pages."));

/** Set for fast validation. */
const CAPABILITY_SET: ReadonlySet<string> = new Set(ALL_CAPABILITY_KEYS);

export function isCapabilityKey(key: string): key is CapabilityKey {
  return CAPABILITY_SET.has(key);
}

/** Find the human label + description for a key, or null if unknown. */
export function getCapabilityDef(key: string): CapabilityDef | null {
  for (const domain of CAPABILITIES) {
    for (const cap of domain.capabilities) {
      if (cap.key === key) return cap;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// System-role defaults
// ---------------------------------------------------------------------------
//
// These are the capability sets used when an admin_user has no custom
// role_id yet (transition period). They mirror the behaviour of the
// existing hardcoded roles as closely as possible:
//
//   - admin    → every capability
//   - support  → user moderation + chat + read-most-pages
//   - marketing→ promo/gift/voucher + creators read + marketing pages
//   - creator  → only their own /my-profile actions
//
// Once the user runs the migration + seed, admin_roles rows are created
// with these exact capability sets and admins can start assigning role_ids.

const ALL_KEYS: CapabilityKey[] = [...ALL_CAPABILITY_KEYS];

const SUPPORT_KEYS: CapabilityKey[] = [
  // Pages
  "pages.dashboard",
  "pages.users",
  "pages.withdrawals",
  "pages.transactions",
  "pages.transactions_packs",
  "pages.transactions_battles",
  "pages.transactions_rewards",
  "pages.transactions_deposits",
  "pages.chat",
  "pages.audit",
  // Users
  "users.ban",
  "users.unban",
  "users.lock",
  "users.unlock",
  "users.edit_identity",
  "users.toggle_feature_lock",
  // Balances
  "balances.adjust",
  "balances.adjust_xp",
  // Notes
  "notes.create",
  "notes.delete",
  // Chat moderation
  "chat.delete_message",
  "chat.pin_message",
  "chat.unpin_message",
  "chat.mute_user",
  "chat.unmute_user",
  // Withdrawals
  "withdrawals.process",
  "withdrawals.ship",
  "withdrawals.complete",
  "withdrawals.cancel",
  "withdrawals.fail",
];

const MARKETING_KEYS: CapabilityKey[] = [
  // Pages
  "pages.dashboard",
  "pages.analytics",
  "pages.promo_codes",
  "pages.gift_cards",
  "pages.vouchers",
  "pages.creators",
  "pages.creators_codes",
  "pages.creators_analytics",
  "pages.rewards",
  "pages.rewards_raffles",
  "pages.rewards_leaderboards",
  // Promo / gift / voucher
  "promo_codes.create",
  "promo_codes.delete",
  "promo_codes.view_redemptions",
  "gift_cards.create",
  "gift_cards.cancel",
  "vouchers.create",
  // Raffles / leaderboards read-write (marketing often owns these)
  "raffles.create",
  "raffles.update",
  "leaderboards.upsert_prize_tier",
  "leaderboards.delete_prize_tier",
];

const CREATOR_KEYS: CapabilityKey[] = [
  "pages.my_profile",
  "my_profile.create_webhook",
  "my_profile.update_webhook",
  "my_profile.delete_webhook",
  "my_profile.test_webhook",
  "my_profile.link_social",
  "my_profile.unlink_social",
];

/**
 * Capability set for each of the four hardcoded system roles.
 * Used as fallback when admin_user.role_id is null.
 */
export const SYSTEM_ROLE_CAPABILITIES: Record<
  "admin" | "support" | "marketing" | "creator",
  readonly CapabilityKey[]
> = {
  admin: ALL_KEYS,
  support: SUPPORT_KEYS,
  marketing: MARKETING_KEYS,
  creator: CREATOR_KEYS,
};

/**
 * Metadata for each system role (used by the seed script + role UI).
 * Names are kept lowercase to match the admin_role enum.
 */
export const SYSTEM_ROLES: readonly {
  name: "admin" | "support" | "marketing" | "creator";
  label: string;
  description: string;
}[] = [
  { name: "admin", label: "Admin", description: "Full access. Built-in role, cannot be edited." },
  { name: "support", label: "Support", description: "Customer support: user moderation, chat, transactions." },
  { name: "marketing", label: "Marketing", description: "Marketing: promo codes, gift cards, creators, analytics." },
  { name: "creator", label: "Creator", description: "Creator self-service: only /my-profile actions." },
];
