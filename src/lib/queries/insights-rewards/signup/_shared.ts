/**
 * Shared cohort definition + cache tagging for the
 * /insights/rewards/signup query helpers.
 *
 * Every helper in this folder operates on the same cohort:
 *   - The "signup cohort" is users whose `user.created_at` falls inside
 *     the selected window. `null` window → lifetime.
 *   - The "claimant cohort" is the subset of the signup cohort that
 *     has at least one `balance_reward_claim` ledger row at ANY time
 *     (NOT restricted to the window — admins ask "did this signup ever
 *     redeem the signup bonus" not "did they redeem within X days").
 *
 * The platform has NO dedicated `signup_bonus` ledger type — all signup
 * pack / welcome reward claims land in the generic
 * `balance_reward_claim` row (verified against the MAIN Drizzle schema
 * enum `ledger_transaction_type`). The narrowing comes from joining
 * the signup-window cohort against the user's `balance_reward_claim`
 * rows, exactly as the existing `getSignupExtras` helper does.
 *
 * Staff (admin / support) excluded everywhere. Blacklist
 * (`excluded_users`) excluded everywhere. Cache keys include the
 * sorted blacklist signature so admins editing the excluded-users
 * list see fresh numbers on the next tick.
 *
 * Cache tag is `insights-rewards-signup` so the whole page can be
 * busted with one `revalidateTag(...)` call.
 */

export const SIGNUP_CACHE_TAG = "insights-rewards-signup";
