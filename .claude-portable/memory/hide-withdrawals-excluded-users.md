---
name: hide-withdrawals-excluded-users
description: "How to fulfill owner's \"hide all withdrawal info for user X (same as kartos)\" requests"
metadata: 
  node_type: memory
  type: project
  originSessionId: 00a34da5-2120-4207-8c8f-e270a26209bb
---

Owner recurring request: "hide all withdrawal info for user <id>, same as kartos, nowhere findable."

**The only mechanism = add the user_id to the `excluded_users` blacklist (ADMIN DB).** There is NO withdrawal-only flag — withdrawal-hiding is a *consequence* of full blacklist membership, driven by `getExcludedUserIds()` (`src/lib/excluded-users/fetch.ts`). The suppression code is fully generic on that list, so **no code change is needed — it's a single data insert.**

Being on the list hides the user EVERYWHERE at once: `/users/[id]` withdrawal rows+amounts+Total-Withdrawn KPI+count+Card-Withdrawals table (users-detail.ts / users-transactions.ts); `/withdrawals` + `/physical` queue (dropped from list AND count, unless a motha unlock override exists in `admin_withdrawal_unlocks`); ALL analytics/PnL/GGR/wager aggregates; search / user-list / CMD+K for ordinary admins. Withdrawals also become LOCKED from being actioned. Owner has accepted these side effects (confirmed 2026-07-04) — it IS the kartos treatment.

**How to apply:** replicate `addExcludedUser` (`src/app/(admin)/system/excluded-users/actions.ts`) — insert `excluded_users` (user_id, reason, excluded_by=owner admin id, timestamps; ON CONFLICT DO NOTHING) + an `excluded_user_added` audit event. Do it via a temp `node --env-file=.env` `pg` script against `ADMIN_DATABASE_URL` (admin DB = full write access), then delete the script. Live immediately for suppression paths; cached analytics aggregates (60–300s TTL) self-heal on expiry.

**Owner search bypass — "not even motha/kotha" (owner request 2026-07-04):** blacklist membership hides a user from ORDINARY admins' search, but OWNERS (motha/kotha, `is_owner`/`isExcludedSearchOwnerRow`) still find blacklisted users via the /users search box AND the CMD+K palette (`includeAllBlacklisted` → returned `[]` = exclude nobody). Withdrawal DATA + analytics were already hidden from owners too (generic, no owner override), so search findability was the ONLY owner-visible gap. To hide from EVERYONE incl. owners, add the id to `ALWAYS_HIDDEN_FROM_SEARCH` in `src/lib/excluded-users/search-visible-override.ts` (hard-hide tier, unioned into the exclude-list on every path incl. the owner bypass). Both search surfaces now route through `getExcludedUserIdsForAdminSearch` (CMD+K's `searchUsersGlobal` was refactored to use it — commit 680667af, 2026-07-04). This tier is a CODE const → requires a push/deploy (unlike the data-only blacklist insert). Residual: an owner who already knows the exact user_id can still open `/users/[id]` directly (renders the profile minus withdrawals) — not yet blocked; offer a `notFound()` gate if the owner wants that too.

Users hidden so far: kartos (`vqsEpQYADwxZ421j2aCV87R2qyIkN6Zd`, removed from search entirely 2026-07-01), `VRqlwTZCJD8wEBa1HHRnGeF8iiKlwh2e` (added 2026-07-04). See [[owner-lens-verification]].
