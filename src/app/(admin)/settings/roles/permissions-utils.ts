// Non-"use server" module for pure utility functions that need to be
// imported by both server actions and server components. Can't live in
// actions.ts because that file has "use server" and Next.js requires
// every export from a "use server" file to be an async function.
//
// Capabilities are stored as special keys in the existing allowed_pages
// String[] column — prefixed with "__" so they don't collide with page
// routes. This avoids DB migrations entirely.

import { ALL_PAGE_KEYS } from "@/lib/admin-pages";

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
  {
    key: "__can_export_users",
    label: "Export User Emails",
    description:
      "Download a CSV of user emails (PII) via /api/users/export. Admin-only by default — grant manually to any non-admin role that needs it.",
    group: "User Management",
  },
  {
    // Admin-CRM tagging on user profiles. Allow-list:
    // 'contacted_vip' | 'confirmed_vip' | 'wager_abuser'. Stored
    // admin-side only — never written to the main game DB / never
    // exposed to users.
    key: "__can_manage_user_tags",
    label: "Manage User Tags",
    description:
      "Set or remove user tags (Contacted VIP, Confirmed VIP, Wager Abuser) on user profiles. Tags are admin-internal CRM metadata — never visible to the user themselves.",
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
    description: "Configure the real user account used for house ad tracking codes",
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
  {
    key: "__can_record_manual_withdrawal",
    label: "Record Manual Withdrawal",
    description:
      "Record an off-platform payout — deducts the user's on-site balance and bumps total_withdrawn so P&L stays correct (subject to the per-admin balance limit).",
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
    // Pack creators are normally locked out of editing ACTIVE (live)
    // packs — only inactive demo packs. This capability lifts that
    // restriction so they can change card weights / price / house
    // edge on packs that are currently in production. Sensitive:
    // grant only to trusted pack_creator employees who understand
    // they're directly changing an in-production game's economics.
    key: "__can_edit_live_packs",
    label: "Edit Live Packs",
    description:
      "Allow editing of active (live) packs — required for pack creators to change card pool / price / house edge after a pack is live. Without this, a pack creator can only edit demo (inactive) packs. Real admins always pass.",
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

  // ── Sets ────────────────────────────────────────────────────────────
  {
    key: "__can_create_set",
    label: "Create Set",
    description: "Add a new set / series (name, series, language) to the catalog",
    group: "Sets",
  },
  {
    key: "__can_update_set",
    label: "Update Set",
    description: "Edit name, series, language, or release date of an existing set",
    group: "Sets",
  },
  {
    key: "__can_upload_set_image",
    label: "Upload Set Image",
    description: "Upload or replace a set logo image",
    group: "Sets",
  },
  {
    key: "__can_seed_initial_sets",
    label: "Seed Initial Sets",
    description:
      "One-time backfill: create the Pokemon and OnePiece sets and move every card without a set into Pokemon",
    group: "Sets",
  },
  {
    key: "__can_force_absorb_cards",
    label: "Force-Absorb Cards into Pokemon",
    description:
      "Move EVERY card NOT in the OnePiece set into the Pokemon set (catches legacy import sets the initial seed missed) and optionally delete empty legacy sets. Destructive — admin-only by default.",
    group: "Sets",
  },
  {
    key: "__can_delete_set",
    label: "Delete Set",
    description:
      "Permanently delete a set. Cards in the set are NOT deleted — their set assignment is cleared and they remain in the catalog as orphan cards, available for bulk-assign on /cards.",
    group: "Sets",
  },

  // ── Upgrader (output-card pool on /upgrader) ────────────────────────
  {
    key: "__can_add_upgrader_output",
    label: "Add Upgrader Outputs",
    description:
      "Add cards to the upgrader output pool (the prize cards a player's upgrade can land on)",
    group: "Upgrader",
  },
  {
    key: "__can_toggle_upgrader_output",
    label: "Edit Upgrader Outputs",
    description:
      "Enable / disable an upgrader output card or change its display color",
    group: "Upgrader",
  },
  {
    key: "__can_remove_upgrader_output",
    label: "Remove Upgrader Outputs",
    description: "Remove a card from the upgrader output pool",
    group: "Upgrader",
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

  // ── Challenges ──────────────────────────────────────────────────────
  {
    key: "__can_create_challenge",
    label: "Create Challenge",
    description: "Create a new game challenge (card-hit or upgrader-hit)",
    group: "Challenges",
  },
  {
    key: "__can_update_challenge",
    label: "Update Challenge",
    description: "Edit a challenge's prize, claim cap, or status",
    group: "Challenges",
  },
  {
    key: "__can_archive_challenge",
    label: "Archive Challenge",
    description: "Archive (soft-delete) a challenge",
    group: "Challenges",
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
  {
    key: "__can_manage_race_periods",
    label: "Manage Race Periods",
    description:
      "Start a race period (incl. monthly with custom dates), toggle auto-renew, or end an active period now",
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
    key: "__can_review_creator_social",
    label: "Review Creator Social",
    description: "Approve or reject creator-submitted social account",
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
    key: "__can_link_creator_main_user",
    label: "Link Creator to Main User",
    description: "Link a creator admin user to their main-site user",
    group: "Creators",
  },
  {
    // Newly split out from __can_update_creator_deal — approval, rejection, and
    // cancellation of submitted affiliate leaderboards. Admin-only by default;
    // existing assignees of __can_update_creator_deal must add this new key
    // manually in /admin-users (we deliberately do not migrate the prod
    // allowed_pages arrays).
    key: "__can_approve_leaderboard",
    label: "Approve Affiliate Leaderboard",
    description:
      "Approve, reject, or cancel a creator-submitted affiliate leaderboard",
    group: "Creators",
  },
  {
    key: "__can_rotate_creator_api_key",
    label: "Rotate Creator API Key",
    description:
      "Generate or regenerate a creator's external API key (affiliate stats, leaderboards)",
    group: "Creators",
  },

  // ── Multiplier deals (parallel program, separate capabilities) ─────
  // Split into four keys so the "Review" action — which moves real money
  // at settlement — is gated independently of the offer-management
  // actions. Existing creator-deal capabilities don't carry over; admins
  // must be explicitly granted multiplier permissions.
  {
    key: "__can_create_multiplier_deal",
    label: "Create Multiplier Deal",
    description:
      "Create a multiplier deal offer for a creator (covers cancel of pending offers)",
    group: "Creators",
  },
  {
    key: "__can_update_multiplier_deal",
    label: "Update Multiplier Deal",
    description: "Edit a pending_deposit multiplier deal's contract terms",
    group: "Creators",
  },
  {
    key: "__can_force_end_multiplier_stream",
    label: "Force-End Multiplier Stream",
    description:
      "Force-end a live multiplier stream (bypasses VOD requirement; deal moves to flagged)",
    group: "Creators",
  },
  {
    key: "__can_review_multiplier_deal",
    label: "Review Multiplier Deal",
    description:
      "Approve, reject, or manually flag a multiplier deal at settlement — moves real money (voucher creation or deposit refund/forfeit)",
    group: "Creators",
  },

  // ── Employees (expense tracking + shift planning) ──────────────────
  {
    key: "__can_create_expense",
    label: "Create Expense",
    description: "Log a one-off expense",
    group: "Employees",
  },
  {
    key: "__can_update_expense",
    label: "Update Expense",
    description: "Edit an expense",
    group: "Employees",
  },
  {
    key: "__can_delete_expense",
    label: "Delete Expense",
    description: "Remove an expense",
    group: "Employees",
  },
  {
    key: "__can_create_recurring_expense",
    label: "Create Recurring Expense",
    description: "Add a recurring expense entry",
    group: "Employees",
  },
  {
    key: "__can_update_recurring_expense",
    label: "Update Recurring Expense",
    description: "Edit a recurring expense",
    group: "Employees",
  },
  {
    key: "__can_toggle_recurring_expense",
    label: "Toggle Recurring Expense",
    description: "Enable / disable a recurring expense",
    group: "Employees",
  },
  {
    key: "__can_delete_recurring_expense",
    label: "Delete Recurring Expense",
    description: "Remove a recurring expense",
    group: "Employees",
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

  // ── System (site-wide security capabilities) ──────────────────────────
  {
    key: "__can_upsert_site_config",
    label: "Upsert Site Config",
    description: "Create or update site-wide security / config entries",
    group: "System",
  },
  {
    key: "__can_delete_site_config",
    label: "Delete Site Config",
    description: "Remove a site-wide security / config entry",
    group: "System",
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

// ---------------------------------------------------------------------------
// Unified permission catalog — pages + capabilities in one vocabulary.
//
// `allowed_pages` (and `admin_roles.capabilities`, which now uses the same
// format) holds two kinds of entry:
//   • page routes      — "/dashboard", "/users", …   (from ADMIN_PAGES)
//   • capability flags — "__can_ban_users", …         (from CAPABILITIES)
// These helpers validate against that combined set and recompute a user's
// effective permissions when their assigned role preset changes.
// ---------------------------------------------------------------------------

/** Every valid permission key — page routes ∪ capability flags. */
export const ALL_PERMISSION_KEYS: readonly string[] = [
  ...ALL_PAGE_KEYS,
  ...CAPABILITY_KEYS,
];

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(ALL_PERMISSION_KEYS);

/** True for a recognized page route or `__can_*` capability key. */
export function isPermissionKey(key: string): boolean {
  return PERMISSION_KEY_SET.has(key);
}

// ---------------------------------------------------------------------------
// Value tokens — `<base>:<value>` entries that carry data (a numeric limit)
// alongside a recognized base key. These live in the same `allowed_pages`
// String[] column as bare keys but encode a value after a colon, e.g.
//   • "__balance_limit_daily:10"      (legacy per-admin balance cap; void holds this)
//   • "__balance_limit_weekly:500"    (legacy weekly variant)
//   • "__can_adjust_balance_limit_daily:500"  (current format from buildCapabilityKeys)
//
// The bare `isPermissionKey` check rejects them (the colon-suffixed string is
// not in ALL_PERMISSION_KEYS), which is why the OLD sanitizer dropped them —
// silently discarding void's "__balance_limit_daily:10". `sanitizePermissionKeys`
// must preserve them VERBATIM whenever their base is recognized, while still
// dropping genuinely-unknown value tokens. (See ROLE_REDESIGN_DESIGN.md
// §"Highest-attention risk".)
// ---------------------------------------------------------------------------

/**
 * Recognized value-token base keys, WITHOUT the trailing `:<value>`:
 *
 *   - the two legacy balance-limit bases (`__balance_limit_daily` /
 *     `__balance_limit_weekly`, parsed by `parseBalanceLimit`), and
 *   - the per-capability limit form `${capKey}_limit_${period}` for EVERY
 *     capability key, in both `daily` and `weekly` periods — exactly the
 *     prefixes `parseLimit` understands and `buildCapabilityKeys` emits.
 *
 * Derived from the catalog so any capability's limit token is recognized
 * automatically; nothing is hard-coded beyond the two legacy bases. (We key
 * off every `capKey` rather than only `hasLimit` ones because `hasLimit` is a
 * UI hint that is currently unset on every capability, while the legacy
 * `__balance_limit_*` value tokens are real and live — e.g. void's
 * `__balance_limit_daily:10`.)
 */
const VALUE_TOKEN_BASES: ReadonlySet<string> = new Set<string>([
  // Legacy per-admin balance cap (parsed by parseBalanceLimit).
  "__balance_limit_daily",
  "__balance_limit_weekly",
  // Per-capability limit format (`${capKey}_limit_${period}`), all capabilities.
  ...CAPABILITY_KEYS.flatMap((key) => [
    `${key}_limit_daily`,
    `${key}_limit_weekly`,
  ]),
]);

/**
 * True for a `<base>:<value>` value token whose base is recognized AND whose
 * value is a finite positive number (matching the parse guards in
 * `parseLimit` / `parseBalanceLimit`). Unknown bases or non-numeric / ≤0
 * values are rejected so a stale or malformed token is still dropped.
 */
export function isValueToken(token: string): boolean {
  const colon = token.indexOf(":");
  if (colon === -1) return false;
  const base = token.slice(0, colon);
  if (!VALUE_TOKEN_BASES.has(base)) return false;
  const value = Number(token.slice(colon + 1));
  return Number.isFinite(value) && value > 0;
}

/**
 * Keep only recognized permission entries, de-duplicated (drops stale ones).
 *
 * Value-token-aware: an entry survives if it is EITHER a bare recognized
 * permission key (`isPermissionKey`) OR a recognized `<base>:<value>` value
 * token (`isValueToken`). This preserves tokens like
 * `__balance_limit_daily:10` that the bare-key filter alone would discard,
 * while genuinely-unknown tokens are still dropped. Order is preserved
 * (first occurrence wins) so a materialized array stays stable.
 */
export function sanitizePermissionKeys(keys: string[]): string[] {
  return Array.from(
    new Set(keys.filter((k) => isPermissionKey(k) || isValueToken(k))),
  );
}

/**
 * Recompute a user's effective `allowed_pages` when their role preset
 * changes — either the role was re-assigned, or the role itself edited.
 *
 * "Role + adjustments" model: effective = role preset, plus per-user
 * grants, minus per-user revokes. The adjustment delta is derived by
 * diffing the user's CURRENT allowed_pages against the OLD preset:
 *   extra  = currentAllowed \ oldPreset   (granted manually on top)
 *   denied = oldPreset \ currentAllowed   (revoked manually)
 * New effective = (newPreset ∪ extra) \ denied.
 *
 * With no previous role (oldPreset = []), the user's whole current set
 * becomes "extra" and merges onto the new preset — nothing is lost.
 */
export function materializeAllowedPages(
  newPreset: string[],
  currentAllowed: string[],
  oldPreset: string[],
): string[] {
  const oldSet = new Set(oldPreset);
  const curSet = new Set(currentAllowed);
  const extra = currentAllowed.filter((k) => !oldSet.has(k));
  const denied = new Set(oldPreset.filter((k) => !curSet.has(k)));
  const out = new Set<string>([...newPreset, ...extra]);
  for (const d of denied) out.delete(d);
  return Array.from(out);
}
