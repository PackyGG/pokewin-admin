// Non-"use server" module for pure utility functions that need to be
// imported by both server actions and server components. Can't live in
// actions.ts because that file has "use server" and Next.js requires
// every export from a "use server" file to be an async function.

const BALANCE_ADJUST_KEY = "__can_adjust_balance";

/** Check if a given admin user has the balance adjust capability. */
export function canUserAdjustBalance(allowedPages: string[]): boolean {
  return allowedPages.includes(BALANCE_ADJUST_KEY);
}

/** Parse the daily balance limit from allowed_pages, e.g. "__balance_limit_daily:500" → 500 */
export function parseBalanceLimit(pages: string[]): number | null {
  for (const p of pages) {
    if (p.startsWith("__balance_limit_daily:")) {
      const val = Number(p.split(":")[1]);
      return Number.isFinite(val) && val > 0 ? val : null;
    }
  }
  return null;
}

export { BALANCE_ADJUST_KEY };
