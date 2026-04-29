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
