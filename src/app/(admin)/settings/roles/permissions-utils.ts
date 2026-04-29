// Non-"use server" module for pure utility functions that need to be
// imported by both server actions and server components. Can't live in
// actions.ts because that file has "use server" and Next.js requires
// every export from a "use server" file to be an async function.
//
// Capabilities are stored as special keys in the existing allowed_pages
// String[] column — prefixed with "__" so they don't collide with page
// routes. This avoids DB migrations entirely.

// ---------------------------------------------------------------------------
// Capability definitions
// ---------------------------------------------------------------------------

export type CapabilityDef = {
  key: string;
  label: string;
  description: string;
  group: string;
  /** If true, this capability has an associated numeric limit. */
  hasLimit?: boolean;
  /** Label for the limit input, e.g. "24h Limit (USD)" */
  limitLabel?: string;
  /** If true, the limit has a period selector (daily / weekly). */
  hasPeriod?: boolean;
};

export const CAPABILITIES: CapabilityDef[] = [
  // ── User Management ─────────────────────────────────────────────────
  {
    key: "__can_adjust_balance",
    label: "Adjust Balance",
    description:
      "Add or subtract balance from user accounts. Per-admin daily/weekly/monthly caps are configured individually on each admin's profile.",
    group: "User Management",
  },
  {
    key: "__can_adjust_xp",
    label: "Adjust XP",
    description: "Add or subtract XP from user accounts",
    group: "User Management",
  },
  {
    key: "__can_edit_identity",
    label: "Edit User Identity",
    description: "Change email, username, and display name",
    group: "User Management",
  },
  {
    key: "__can_ban_users",
    label: "Ban / Unban Users",
    description: "Ban users from the platform or lift existing bans",
    group: "User Management",
  },
  {
    key: "__can_lock_users",
    label: "Lock / Unlock Users",
    description: "Temporarily lock user accounts or unlock them",
    group: "User Management",
  },
  {
    key: "__can_toggle_feature_locks",
    label: "Toggle Feature Locks",
    description: "Lock/unlock deposits, withdrawals, exchanges, openings, vault per user",
    group: "User Management",
  },
  {
    key: "__can_assign_affiliate",
    label: "Manage Affiliate Codes",
    description: "Assign or create affiliate codes for users",
    group: "User Management",
  },
  {
    key: "__can_update_user_withdrawal_limits",
    label: "Update Withdrawal Limits",
    description: "Set per-user creator/withdrawal limits and reset windows",
    group: "User Management",
  },

  // ── User Notes & Trust ──────────────────────────────────────────────
  {
    key: "__can_create_user_note",
    label: "Create Note",
    description: "Add an internal admin note to a user profile",
    group: "User Notes & Trust",
  },
  {
    key: "__can_delete_user_note",
    label: "Delete Note",
    description: "Delete an internal admin note from a user profile",
    group: "User Notes & Trust",
  },
  {
    key: "__can_set_user_trust",
    label: "Set Trust Status",
    description: "Mark a user as trusted / suspected alt or update trust flags",
    group: "User Notes & Trust",
  },

  // ── Dangerous / Destructive ──────────────────────────────────────────
  {
    key: "__can_wipe_accounts",
    label: "Wipe Account Data",
    description: "Permanently delete all data for a user account (irreversible)",
    group: "Dangerous Actions",
  },
  {
    key: "__can_change_user_roles",
    label: "Change User Roles",
    description: "Change a user's role (user, support, admin, creator)",
    group: "Dangerous Actions",
  },
  {
    key: "__can_delete_user",
    label: "Delete User",
    description: "Permanently delete a single user account (requires 2FA)",
    group: "Dangerous Actions",
  },
  {
    key: "__can_bulk_delete_users",
    label: "Bulk Delete Users",
    description: "Delete up to 100 users at once (requires 2FA)",
    group: "Dangerous Actions",
  },

  // ── Moderation ──────────────────────────────────────────────────────
  {
    key: "__can_mute_users",
    label: "Mute Users",
    description: "Mute users in chat (temporary or permanent)",
    group: "Moderation",
  },
  {
    key: "__can_delete_messages",
    label: "Delete Chat Messages",
    description: "Delete messages in the chat",
    group: "Moderation",
  },
  {
    key: "__can_pin_messages",
    label: "Pin / Unpin Chat Messages",
    description: "Pin or unpin messages in the chat",
    group: "Moderation",
  },

  // ── Ads ─────────────────────────────────────────────────────────────
  {
    key: "__can_set_house_account",
    label: "Set Ads House Account",
    description: "Configure the real user account used for /creators/ads codes",
    group: "Ads",
  },
  {
    key: "__can_create_ad_code",
    label: "Create Ad Code",
    description: "Create a new ad tracking code on the house account",
    group: "Ads",
  },
  {
    key: "__can_delete_ad_code",
    label: "Delete Ad Code",
    description: "Delete an ad tracking code from the house account",
    group: "Ads",
  },

  // ── Withdrawals ─────────────────────────────────────────────────────
  {
    key: "__can_process_withdrawals",
    label: "Process Withdrawals",
    description: "Move pending withdrawals into processing",
    group: "Withdrawals",
  },
  {
    key: "__can_ship_withdrawals",
    label: "Ship Withdrawals",
    description: "Mark physical withdrawals as shipped (with tracking)",
    group: "Withdrawals",
  },
  {
    key: "__can_complete_withdrawals",
    label: "Complete Withdrawals",
    description: "Mark withdrawals as delivered / complete",
    group: "Withdrawals",
  },
  {
    key: "__can_cancel_withdrawals",
    label: "Cancel Withdrawals",
    description: "Cancel pending / processing withdrawals and refund balance",
    group: "Withdrawals",
  },
  {
    key: "__can_fail_withdrawals",
    label: "Fail Withdrawals",
    description: "Mark withdrawals as failed",
    group: "Withdrawals",
  },

  // ── Packs ───────────────────────────────────────────────────────────
  {
    key: "__can_create_pack",
    label: "Create Pack",
    description: "Create a new pack (cards, RTP, price)",
    group: "Packs",
  },
  {
    key: "__can_update_pack",
    label: "Update Pack",
    description: "Edit pack details, card pool, and RTP",
    group: "Packs",
  },
  {
    key: "__can_delete_pack",
    label: "Delete Pack",
    description: "Permanently delete a pack",
    group: "Packs",
  },
  {
    key: "__can_toggle_pack_active",
    label: "Activate / Deactivate Pack",
    description: "Toggle whether a pack is purchasable on the site",
    group: "Packs",
  },
  {
    key: "__can_upload_pack_image",
    label: "Upload Pack Image",
    description: "Upload or replace a pack cover image",
    group: "Packs",
  },

  // ── Cards ───────────────────────────────────────────────────────────
  {
    key: "__can_create_card",
    label: "Create Card",
    description: "Add a new card to the catalog",
    group: "Cards",
  },
  {
    key: "__can_update_card",
    label: "Update Card",
    description: "Edit card details (name, rarity, price, …)",
    group: "Cards",
  },
  {
    key: "__can_delete_card",
    label: "Delete Card",
    description: "Remove a card from the catalog",
    group: "Cards",
  },
  {
    key: "__can_upload_card_image",
    label: "Upload Card Image",
    description: "Upload or replace a card image",
    group: "Cards",
  },

  // ── Battles ─────────────────────────────────────────────────────────
  {
    key: "__can_cancel_battle",
    label: "Cancel Battle",
    description: "Cancel an in-progress battle and refund all participants",
    group: "Battles",
  },

  // ── Rewards & Rakeback ──────────────────────────────────────────────
  {
    key: "__can_create_reward",
    label: "Create Reward",
    description: "Create a reward entry",
    group: "Rewards",
  },
  {
    key: "__can_update_reward",
    label: "Update Reward",
    description: "Edit an existing reward",
    group: "Rewards",
  },
  {
    key: "__can_delete_reward",
    label: "Delete Reward",
    description: "Remove a reward",
    group: "Rewards",
  },
  {
    key: "__can_reload_reward_packs",
    label: "Reload Reward Packs",
    description: "Refresh the cached pack list used for rewards",
    group: "Rewards",
  },
  {
    key: "__can_update_rakeback",
    label: "Update Rakeback Config",
    description: "Edit the rakeback tier / level configuration",
    group: "Rewards",
  },

  // ── Raffles ─────────────────────────────────────────────────────────
  {
    key: "__can_create_raffle",
    label: "Create Raffle",
    description: "Create a new raffle",
    group: "Raffles",
  },
  {
    key: "__can_update_raffle",
    label: "Update Raffle",
    description: "Edit an existing raffle",
    group: "Raffles",
  },
  {
    key: "__can_cancel_raffle",
    label: "Cancel Raffle",
    description: "Cancel an active raffle and refund participants",
    group: "Raffles",
  },

  // ── Race Leaderboards ───────────────────────────────────────────────
  {
    key: "__can_upsert_race_prize_tier",
    label: "Upsert Race Prize Tier",
    description: "Create or update a race / leaderboard prize tier",
    group: "Race Leaderboards",
  },
  {
    key: "__can_delete_race_prize_tier",
    label: "Delete Race Prize Tier",
    description: "Remove a race / leaderboard prize tier",
    group: "Race Leaderboards",
  },

  // ── Rain ────────────────────────────────────────────────────────────
  {
    key: "__can_adjust_rain_base",
    label: "Adjust Rain Base",
    description: "Change the base amount for an active rain event",
    group: "Rain",
  },
  {
    key: "__can_update_rain_config",
    label: "Update Rain Config",
    description: "Edit the rain configuration (cooldown, thresholds, …)",
    group: "Rain",
  },

  // ── Promo Codes ─────────────────────────────────────────────────────
  {
    key: "__can_create_promo_code",
    label: "Create Promo Code",
    description: "Issue a new promo code",
    group: "Promo Codes",
  },
  {
    key: "__can_delete_promo_code",
    label: "Delete Promo Code",
    description: "Delete an existing promo code",
    group: "Promo Codes",
  },
  {
    key: "__can_view_promo_redemptions",
    label: "View Promo Redemptions",
    description: "List who redeemed a promo code",
    group: "Promo Codes",
  },

  // ── Gift Cards ──────────────────────────────────────────────────────
  {
    key: "__can_create_gift_card",
    label: "Create Gift Card",
    description: "Generate a new gift card",
    group: "Gift Cards",
  },
  {
    key: "__can_cancel_gift_card",
    label: "Cancel Gift Card",
    description: "Cancel an issued gift card",
    group: "Gift Cards",
  },

  // ── Vouchers ────────────────────────────────────────────────────────
  {
    key: "__can_create_voucher",
    label: "Create Voucher",
    description: "Issue a voucher to a user",
    group: "Vouchers",
  },

  // ── Creators ────────────────────────────────────────────────────────
  {
    key: "__can_make_creator",
    label: "Promote to Creator",
    description: "Promote a user to creator status",
    group: "Creators",
  },
  {
    key: "__can_update_creator_affiliate_level",
    label: "Update Creator Affiliate Level",
    description: "Change a creator's affiliate level",
    group: "Creators",
  },
  {
    key: "__can_update_creator_limits",
    label: "Update Creator Limits",
    description: "Edit a creator's withdrawal / tip limits",
    group: "Creators",
  },
  {
    key: "__can_approve_creator_payout",
    label: "Approve Creator Payout",
    description: "Process a creator payout request",
    group: "Creators",
  },
  {
    key: "__can_update_creator_level_config",
    label: "Update Creator Level Config",
    description: "Change the global affiliate level / commission config",
    group: "Creators",
  },
  {
    key: "__can_update_creator_cut_expiration",
    label: "Update Creator Cut Expiration",
    description: "Set when an affiliate cut expires per signup",
    group: "Creators",
  },
  {
    key: "__can_toggle_creator_code",
    label: "Toggle Creator Code",
    description: "Enable / disable a creator's affiliate code",
    group: "Creators",
  },
  {
    key: "__can_create_creator_webhook",
    label: "Create Creator Webhook",
    description: "Add a webhook for balance fills or deal events",
    group: "Creators",
  },
  {
    key: "__can_update_creator_webhook",
    label: "Update Creator Webhook",
    description: "Edit an existing creator webhook",
    group: "Creators",
  },
  {
    key: "__can_delete_creator_webhook",
    label: "Delete Creator Webhook",
    description: "Remove a creator webhook",
    group: "Creators",
  },
  {
    key: "__can_test_creator_webhook",
    label: "Test Creator Webhook",
    description: "Fire a test delivery to a creator webhook",
    group: "Creators",
  },
  {
    key: "__can_link_creator_social",
    label: "Link Creator Social",
    description: "Link a social media account to a creator profile",
    group: "Creators",
  },
  {
    key: "__can_unlink_creator_social",
    label: "Unlink Creator Social",
    description: "Remove a creator's linked social account",
    group: "Creators",
  },
  {
    key: "__can_create_creator_deal",
    label: "Create Creator Deal",
    description: "Create a creator deal (daily fills, leaderboard, sponsorship)",
    group: "Creators",
  },
  {
    key: "__can_update_creator_deal",
    label: "Update Creator Deal",
    description: "Edit a creator deal",
    group: "Creators",
  },
  {
    key: "__can_delete_creator_deal",
    label: "Delete Creator Deal",
    description: "Remove a creator deal",
    group: "Creators",
  },
  {
    key: "__can_manual_creator_fill",
    label: "Manual Balance Fill",
    description: "Trigger a manual balance fill on a creator deal",
    group: "Creators",
  },
  {
    key: "__can_link_creator_main_user",
    label: "Link Creator to Main User",
    description: "Link a creator admin user to their main-site user",
    group: "Creators",
  },

  // ── Spending ────────────────────────────────────────────────────────
  {
    key: "__can_create_expense",
    label: "Create Expense",
    description: "Log a one-off expense",
    group: "Spending",
  },
  {
    key: "__can_update_expense",
    label: "Update Expense",
    description: "Edit an expense",
    group: "Spending",
  },
  {
    key: "__can_delete_expense",
    label: "Delete Expense",
    description: "Remove an expense",
    group: "Spending",
  },
  {
    key: "__can_create_recurring_expense",
    label: "Create Recurring Expense",
    description: "Add a recurring expense entry",
    group: "Spending",
  },
  {
    key: "__can_update_recurring_expense",
    label: "Update Recurring Expense",
    description: "Edit a recurring expense",
    group: "Spending",
  },
  {
    key: "__can_toggle_recurring_expense",
    label: "Toggle Recurring Expense",
    description: "Enable / disable a recurring expense",
    group: "Spending",
  },
  {
    key: "__can_delete_recurring_expense",
    label: "Delete Recurring Expense",
    description: "Remove a recurring expense",
    group: "Spending",
  },

  // ── Bots ────────────────────────────────────────────────────────────
  {
    key: "__can_create_bot",
    label: "Create Bot",
    description: "Add a chat bot",
    group: "Bots",
  },
  {
    key: "__can_update_bot",
    label: "Update Bot",
    description: "Edit a chat bot",
    group: "Bots",
  },
  {
    key: "__can_toggle_bot_active",
    label: "Toggle Bot Active",
    description: "Enable / disable a chat bot",
    group: "Bots",
  },

  // ── Security (site-wide) ────────────────────────────────────────────
  {
    key: "__can_upsert_site_config",
    label: "Upsert Site Config",
    description: "Create or update site-wide security / config entries",
    group: "Security",
  },
  {
    key: "__can_delete_site_config",
    label: "Delete Site Config",
    description: "Remove a site-wide security / config entry",
    group: "Security",
  },

  // ── Settings (vault locks, country restrictions) ────────────────────
  {
    key: "__can_upsert_vault_lock",
    label: "Upsert Vault Lock",
    description: "Configure vault lock windows",
    group: "Settings",
  },
  {
    key: "__can_delete_vault_lock",
    label: "Delete Vault Lock",
    description: "Remove a vault lock window",
    group: "Settings",
  },
  {
    key: "__can_update_country_restriction",
    label: "Update Country Restriction",
    description: "Edit the blocked-country list",
    group: "Settings",
  },
  {
    key: "__can_toggle_country_restriction",
    label: "Toggle Country Restriction",
    description: "Enable / disable the country restriction enforcement",
    group: "Settings",
  },

  // ── Admin Users (the admin panel's own staff accounts) ──────────────
  {
    key: "__can_create_admin_user",
    label: "Create Admin User",
    description: "Create a new admin-panel user",
    group: "Admin Users",
  },
  {
    key: "__can_toggle_admin_active",
    label: "Activate / Deactivate Admin",
    description: "Enable or disable an admin-panel user",
    group: "Admin Users",
  },
  {
    key: "__can_reset_admin_2fa",
    label: "Reset Admin 2FA",
    description: "Force a 2FA reset for an admin (they must re-enroll)",
    group: "Admin Users",
  },
  {
    key: "__can_change_admin_role",
    label: "Change Admin Role",
    description: "Change an admin user's role (admin / support / marketing / creator) — requires 2FA",
    group: "Admin Users",
  },
  {
    key: "__can_delete_admin_user",
    label: "Delete Admin User",
    description: "Permanently delete an admin-panel user",
    group: "Admin Users",
  },
  {
    key: "__can_force_expire_admin_sessions",
    label: "Force Expire Admin Sessions",
    description: "Invalidate all active sessions of an admin",
    group: "Admin Users",
  },
  {
    key: "__can_update_admin_permissions",
    label: "Update Admin Permissions",
    description: "Edit a non-admin admin user's allowed_pages list",
    group: "Admin Users",
  },
  {
    key: "__can_set_admin_balance_limit",
    label: "Set Admin Balance Limit",
    description: "Configure or remove a per-admin balance adjustment cap",
    group: "Admin Users",
  },

  // ── Admin Roles (custom roles + capabilities) ───────────────────────
  {
    key: "__can_create_admin_role",
    label: "Create Admin Role",
    description: "Define a new custom admin role",
    group: "Admin Roles",
  },
  {
    key: "__can_update_admin_role",
    label: "Update Admin Role",
    description: "Edit an admin role's capabilities",
    group: "Admin Roles",
  },
  {
    key: "__can_delete_admin_role",
    label: "Delete Admin Role",
    description: "Delete a custom admin role (only when unassigned)",
    group: "Admin Roles",
  },
  {
    key: "__can_assign_admin_role",
    label: "Assign Admin Role",
    description: "Set an admin user's custom role assignment",
    group: "Admin Roles",
  },
];

export const CAPABILITY_KEYS = CAPABILITIES.map((c) => c.key);

/** Group capabilities by their group label. */
export function getCapabilityGroups(): { group: string; capabilities: CapabilityDef[] }[] {
  const groups: { group: string; capabilities: CapabilityDef[] }[] = [];
  const seen = new Set<string>();
  for (const cap of CAPABILITIES) {
    if (!seen.has(cap.group)) {
      seen.add(cap.group);
      groups.push({
        group: cap.group,
        capabilities: CAPABILITIES.filter((c) => c.group === cap.group),
      });
    }
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Read helpers — extract capability state from allowed_pages
// ---------------------------------------------------------------------------

/** Check if a capability is enabled. */
export function hasCapability(allowedPages: string[], capKey: string): boolean {
  return allowedPages.includes(capKey);
}

// Legacy alias used by adjustBalance
export function canUserAdjustBalance(allowedPages: string[]): boolean {
  return hasCapability(allowedPages, "__can_adjust_balance");
}

/** Parse a numeric limit value, e.g. "__balance_limit_daily:500" → { period: "daily", amount: 500 } */
export function parseLimit(
  pages: string[],
  capKey: string,
): { period: "daily" | "weekly"; amount: number } | null {
  const prefix = `${capKey}_limit_`;
  for (const p of pages) {
    if (p.startsWith(prefix)) {
      const rest = p.slice(prefix.length); // e.g. "daily:500"
      const [period, amountStr] = rest.split(":");
      const amount = Number(amountStr);
      if ((period === "daily" || period === "weekly") && Number.isFinite(amount) && amount > 0) {
        return { period, amount };
      }
    }
  }
  return null;
}

// Backwards compat — old format was "__balance_limit_daily:500"
export function parseBalanceLimit(pages: string[]): { period: "daily" | "weekly"; amount: number } | null {
  // Try new format first
  const newFormat = parseLimit(pages, "__can_adjust_balance");
  if (newFormat) return newFormat;
  // Fall back to old format
  for (const p of pages) {
    if (p.startsWith("__balance_limit_daily:")) {
      const val = Number(p.split(":")[1]);
      if (Number.isFinite(val) && val > 0) return { period: "daily", amount: val };
    }
    if (p.startsWith("__balance_limit_weekly:")) {
      const val = Number(p.split(":")[1]);
      if (Number.isFinite(val) && val > 0) return { period: "weekly", amount: val };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Write helpers — build allowed_pages entries for capabilities
// ---------------------------------------------------------------------------

export type CapabilityState = {
  enabled: boolean;
  limitPeriod?: "daily" | "weekly";
  limitAmount?: number | null;
};

/** Build the special keys for a set of capability states. */
export function buildCapabilityKeys(
  capabilities: Record<string, CapabilityState>,
): string[] {
  const keys: string[] = [];
  for (const [capKey, state] of Object.entries(capabilities)) {
    if (!state.enabled) continue;
    keys.push(capKey);
    const def = CAPABILITIES.find((c) => c.key === capKey);
    if (def?.hasLimit && state.limitAmount != null && state.limitAmount > 0) {
      const period = state.limitPeriod ?? "daily";
      keys.push(`${capKey}_limit_${period}:${state.limitAmount}`);
    }
  }
  return keys;
}

/** Extract capability states from allowed_pages. */
export function extractCapabilityStates(
  allowedPages: string[],
): Record<string, CapabilityState> {
  const states: Record<string, CapabilityState> = {};
  for (const cap of CAPABILITIES) {
    const enabled = allowedPages.includes(cap.key);
    const limit = cap.hasLimit ? parseLimit(allowedPages, cap.key) ?? parseBalanceLimitLegacy(allowedPages, cap.key) : null;
    states[cap.key] = {
      enabled,
      limitPeriod: limit?.period,
      limitAmount: limit?.amount ?? null,
    };
  }
  return states;
}

function parseBalanceLimitLegacy(
  pages: string[],
  capKey: string,
): { period: "daily" | "weekly"; amount: number } | null {
  if (capKey !== "__can_adjust_balance") return null;
  return parseBalanceLimit(pages);
}
