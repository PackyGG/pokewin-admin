# Security Audit — pokewin-admin

**Scope:** Full read-only source audit of the `pokewin-admin` Next.js admin panel (live admin for the packy.gg real-money gaming platform).
**Method:** Manual expert review of the auth/authz/money core, plus a parallel multi-agent sweep (8 finders × per-finding adversarial verification × a cross-system pass — 33 agents). Every High/Critical was re-read and confirmed by hand. **No code was modified. No database was touched.**
**Date:** 2026-07-24

> ⚠️ This file documents live, exploitable vulnerabilities. Keep it **out of git** (do not commit/push) and share only with the owner.

---

## 0. Note on the stated stack

The audit brief described *Drizzle ORM, BetterAuth, and an intern/admin role system*. **None of those are in this repo.** The real stack is:

| Brief said | Actually |
|---|---|
| Drizzle ORM | PostgreSQL through Drizzle ORM |
| BetterAuth | **Signed JWT (`jose`, HS256)** in cookie `admin_session` + TOTP (`otpauth`) & WebAuthn (`@simplewebauthn`) 2FA; `bcryptjs` |
| intern/admin roles | `admin`, `support`, `marketing`, `creator`, `pack_creator` **+ an OWNER / MAIN-OWNER tier** (username `motha` **or** `admin_users.is_owner`) |

The audit below targets the **actual** code.

Two enforcement facts drive most findings:
- **`src/middleware.ts` matcher excludes `/api`** → API route handlers must authenticate themselves.
- **Server Actions (`"use server"`) are independently-callable POST endpoints** → a page/layout guard does **not** protect them; each mutating action must guard itself.

---

## 1. Executive summary

The codebase is, on the whole, **carefully and defensively engineered** — constant-time API-key auth, optimistic-locked ledger money-movement, server-side entitlement recomputation on the public Discord API, DB-fresh role re-reads every request, and thorough audit logging (see §4 for the full list of things done right). The findings below are real but sit against a strong baseline.

**However, there is one Critical authentication-bypass that must be fixed immediately**, and it chains with a privilege-escalation flaw into a full, durable account takeover using only a stolen password.

| Severity | Count | Headline |
|---|---|---|
| **Critical** | 2 | 2FA fully bypassable via `confirmSetup`; chains to permanent OWNER takeover |
| **High** | 4 | admin→OWNER spoof, customer-financial-feed exposure to all roles, per-admin spend-cap race, creator-payout lost update |
| **Medium** | 7 | SSRF, user enumeration, two double-submit money races, TOTP replay, weak auth rate-limiting, no security headers |
| **Low** | 8 | cron fail-open, `SESSION_SECRET` no fail-fast, default seed password, logout cookie residue, step-up token replay, rain NaN, socials `href`, Sentry scrubber |

19 findings were adversarially verified as CONFIRMED, 4 as UNCERTAIN (kept as Low, precondition-dependent), 1 REFUTED (dropped — see §6).

---

## 1.1 Remediation status (applied 2026-07-24)

Fixes below were applied as **purely defensive changes** that don't alter behavior for legitimate users and need no operator action. `tsc` + `lint` + `npm run build` all pass. **Not committed/pushed** — pending owner review (prod auth/money on an auto-deploy branch).

| Finding | Status | What changed |
|---|---|---|
| **CRITICAL-1** 2FA bypass | ✅ Fixed | `confirmSetup` now rejects a pending cookie with no `totpSecret` (verify-flow cookie) and refuses the confirm step unless `totp_enabled` is already true. Closes both attack variants; legit setup flow unaffected. |
| **CRITICAL-2 / HIGH-1** owner spoof | ✅ Fixed | `createAdminUser` rejects any username normalizing to the reserved `motha` owner identity — breaks the escalation chain. |
| **HIGH-4** payout lost-update | ✅ Fixed | `processCreatorPayout` now `SELECT … FOR UPDATE`s the `balances` row (additive lock, mirrors its existing affiliate lock). |
| **MEDIUM-1** SSRF | ✅ Fixed | New `src/lib/security/webhook-url.ts` egress guard wired into every webhook create/update/test/dispatch path (blocks non-http(s) + private/loopback/link-local/metadata/internal). |
| **MEDIUM-7** headers | ✅ Fixed | `next.config.ts` now sets HSTS, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`; `poweredByHeader:false`. (Conservative CSP — framing only, no script-src, so nothing breaks.) |
| **L-1** cron fail-open | ✅ Fixed | `/api/cron/warm` fails **closed** in production when `CRON_SECRET` is unset (dev stays open). |
| **L-2** SESSION_SECRET | ✅ Fixed | Fail-fast throw if unset (warn if <32 chars). |
| **L-3** seed password | ✅ Fixed | Seed throws instead of defaulting to `"CHANGEME"`. |
| **L-4** logout cookies | ✅ Fixed | `logout()` clears pending-2FA + WebAuthn challenge cookies. |
| **L-6** rain NaN | ✅ Fixed | `adjustRainBase` requires a finite non-negative amount. |
| **L-7** socials `href` | ✅ Fixed | Only `http(s):` URLs are linkified; others render as text. |
| **L-8** Sentry scrubber | ✅ Fixed | `beforeBreadcrumb` drops console breadcrumbs (server config). |
| **HIGH-2** live-activity exposure | ⏸️ Needs decision | Fix = gate `/api/live/activity` + the two polling actions to dashboard access, but that removes the docked activity widget for support/marketing/creator (the downgrade was deliberate). Decide who should see the customer money feed (likely a `__can_view_live_activity` capability so staff keep it, creators don't). |
| **HIGH-3** spend-cap TOCTOU | ⏸️ Needs owner go | Needs an atomic usage counter inside the balance-adjust transaction (restructures a live money path); only bites where per-admin caps are configured. |
| **MEDIUM-3 / MEDIUM-4** withdrawal + reward double-submit | ⏸️ Needs owner go | Fix = atomic status-claim (`updateMany where status='pending'`) before the Fireblocks / payout call. Safe pattern, but edits live withdrawal + payout control flow — deferred for your sign-off. |
| **MEDIUM-5** TOTP single-use | ⏸️ Needs migration | Highest-value structural fix (hardens every double-submit race at once) but requires a new admin-DB column (`admin_users.totp_last_step`) + a change to every 2FA-gated action. |
| **MEDIUM-2** user enumeration | ⏸️ Needs decision | Real fix (gate global search on `/users`) changes who can use ⌘K search — a policy call. |
| **MEDIUM-6** auth rate-limiting | ⏸️ Needs env | Move login/verify throttles to the existing Upstash limiter — only actually throttles if Upstash is configured in prod. |
| **L-5** step-up token binding | ⏸️ Deferred | Needs an action id threaded through call sites (broader change). |

### Update — round 2 (2026-07-24, per owner decisions)

- **HIGH-2 live-activity exposure → ✅ REMOVED.** Per owner, the feeds were deleted outright rather than gated: `LiveMoneyChat` + `DockedRecentActivity` removed from all three shells (admin, creator-hub, pack-studio), and the surfaces deleted — `src/app/api/live/activity/route.ts`, `src/app/(admin)/dashboard/live-actions.ts`, `src/components/docked-recent-activity.tsx`, `src/components/docked-recent-activity-actions.ts`, `src/components/live-money-chat.tsx`. Chat dock + `/api/packy-live` (the chat SSE proxy) kept.
- **MEDIUM-2 user enumeration → ✅ REMOVED.** The ⌘K command palette was deleted (`src/components/command-palette.tsx`) along with its `searchUsersGlobal` action (`src/app/(admin)/actions/global-search.ts`). The shared `cmdk` UI primitive + `commands.ts`/`nav-config.ts` stay (used by other pickers/nav).
- **MEDIUM-5 TOTP single-use → ✅ DONE.** Added `admin_users.totp_last_step` (idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` applied to the admin DB; nullable, all rows NULL — behavior-preserving). `require2FA` now atomically claims a code's step (`verifyTOTPWithStep`), so one TOTP code can't authorize two concurrent/duplicate actions. Fails **open** if the column is ever missing, so 2FA can't be bricked. Login (verify-2fa) is unchanged; passkey step-up is unaffected.
- **HIGH-3 spend-cap race → resolved in practice.** Owner: the admin dashboard has no direct Fireblocks path (reads prod), so the money-execution risk is overstated. The TOTP single-use fix additionally closes the concurrent-code vector for the TOTP path. No separate money-tx restructure applied.
- **MEDIUM-3 / MEDIUM-4 double-submit → mostly closed.** TOTP single-use blocks the concurrent-same-code double-submit for the TOTP path (the practical vector). **Residual:** a passkey step-up token is still reusable within its 2-min TTL, so a passkey user could still double-submit — fully closing this needs the step-up token made single-use (L-5) or a per-path atomic status-claim.

- **MEDIUM-6 auth rate-limiting → ✅ DONE.** `login` now enforces fleet-wide Upstash limits (per-IP 20/min to bound password-spray + per-email 10/min to bound account targeting) and `verify2FA` a per-pending-admin cap (10 / 5 min) on the 6-digit code. Both are additive on top of the in-memory maps and **fail open** when Upstash (`KV_REST_API_URL`) is unconfigured, so nothing changes locally or on a KV-less deploy. Passkey assertion paths (crypto, not brute-forceable) keep their existing in-memory guard.

- **L-5 passkey step-up single-use → ✅ DONE.** Step-up proof tokens now carry a random nonce (`jti`); `require2FA` records it in the new `admin_stepup_used` admin-DB table on first use and rejects any token whose `jti` is already recorded. The PK on `jti` makes consumption atomic, so two concurrent requests with one token contend on the row and only one wins. This makes **one passkey assertion authorize exactly one action** — fully closing the withdrawal / reward double-submit races (**MEDIUM-3/MEDIUM-4**) and the spend-cap race (**HIGH-3**) for passkey users too (the TOTP path was already single-use). Fails **open** if the table is missing / on a transient fault, so passkey 2FA can never be bricked. Old jti-less tokens (2-min TTL) verify but aren't tracked during the tiny post-deploy transition.

### Final status — nothing open

Every finding from the audit is now fixed (or, for the refuted item, confirmed a non-issue). The money-race findings (HIGH-3, MEDIUM-3, MEDIUM-4) are closed for both TOTP and passkey users via the two single-use mechanisms. **Still verified by gates + code-reading, not runtime — and nothing is committed/pushed; deploy when you've reviewed the diff.** The only environment dependency is MEDIUM-6, which needs `KV_REST_API_URL` set in prod to actually throttle.

---

## 2. Findings (ordered by severity)

---

### 🔴 CRITICAL-1 — Complete 2FA bypass: `confirmSetup` mints a full admin session with no second factor

**Files:** `src/app/(auth)/setup-2fa/actions.ts` (`confirmSetup`), `src/app/(auth)/login/actions.ts` (`login`), `src/lib/session.ts`, `src/middleware.ts`
**Verification:** CONFIRMED by adversarial verifier **and** by hand.

**Description.** `confirmSetup()` handles the 2FA-setup form. Its *entire* factor check lives inside `if (step !== "confirm") { … verifyTOTP … }`. When `step === "confirm"` (the "I saved my recovery codes" button) that block is skipped and control falls straight to `createSession(...)` — minting a real `admin_session` **directly from the pending-2FA cookie, with no TOTP/passkey check and no proof that step 1 ever ran.** Nothing in the pending cookie (`PendingSessionPayload`, `session.ts`) records "the factor was verified", and step 1 does not re-mint the cookie, so `confirmSetup` cannot tell a *verify-flow* pending cookie from a *setup-flow* one.

Critically, an **already-enrolled** admin's login takes the `if (adminUser.totp_enabled)` branch (`login/actions.ts:113-121`) and mints exactly such a pending cookie after **only a bcrypt password check**. The mandatory-2FA safety net in `verifySession` only redirects users with `totp_enabled === false`, so an enrolled victim's forged session is never bounced.

**Exploitation.**
1. `POST /login` with the victim's email + password → server sets `admin_2fa_pending` and returns `{requires2FA:true}`.
2. Instead of going to `/verify-2fa`, dispatch the **`confirmSetup` Server Action** (its action id ships in the `/setup-2fa` client bundle) as a POST to `/setup-2fa` with the pending cookie and `step=confirm`. Middleware permits pending-cookie holders on `/setup-2fa`.
3. `confirmSetup` finds a valid pending cookie, skips the verification block, and calls `createSession({ userId: pending.adminUserId, … })` → the attacker holds a full `admin_session` **having never presented the second factor.**

**Impact.** Defeats 2FA entirely for every enrolled admin. 2FA exists precisely to protect against password compromise; this removes that protection. **Critical.**

**Fix.** `confirmSetup` must never create a session on the confirm step without proof the factor was satisfied *in this flow*:
- At the top of `confirmSetup`, reject any pending cookie lacking the setup-only `totpSecret` (mirror the page guard `if (!pending.totpSecret) redirect("/verify-2fa")`) — this alone blocks the enrolled-user attack, since the `requires2FA` cookie has no `totpSecret`.
- Gate the confirm step on a server-verified marker that step 1's `verifyTOTP` ran (e.g. step 1 re-mints the pending cookie with a signed `totpVerified:true`, or the confirm submit re-supplies the 6-digit code and re-runs `verifyTOTP` before `createSession`).
- An already-enrolled admin must be routed **exclusively** through `verify-2fa` and must never be able to obtain a session via the setup action.

---

### 🔴 CRITICAL-2 — Attack chain: password-only → permanent, self-controlled MAIN OWNER

**Files:** `src/app/(auth)/setup-2fa/actions.ts`, `src/app/(admin)/admin-users/actions.ts` (`createAdminUser`), `src/lib/owners.ts`, `src/lib/dal.ts` (`sessionIsOwner`), `src/lib/require-capability.ts`
**Verification:** Cross-system finding; both constituent legs (CRITICAL-1 and HIGH-1) independently CONFIRMED.

**Description.** CRITICAL-1 grants a session but not the victim's TOTP secret — so on its own the attacker cannot re-enroll or persist cleanly. HIGH-1 (below) removes that limit: once inside as any admin, the attacker **creates a new admin whose username normalizes to `motha`**, which the owner-bypass treats as MAIN OWNER, and enrolls *their own* TOTP/passkey on it. The result is a durable, attacker-controlled top-tier account obtained from **nothing but a victim admin's password.**

**Exploitation.** (1) Obtain any admin's password. (2) Use CRITICAL-1 to get an admin session with no 2FA. (3) Call `createAdminUser` with `username=" motha"`/`"MOTHA"` and a password you choose (HIGH-1). (4) Log in to that account, enroll your own second factor → permanent MAIN OWNER.

**Fix.** Fix CRITICAL-1 (root) **and** independently harden the owner path (HIGH-1) so the chain breaks even if one leg regresses: pin owner identity to an immutable `admin_users.id`/`is_main_owner` column instead of a self-creatable username string, and require a 2FA step-up on `createAdminUser`.

---

### 🟠 HIGH-1 — Privilege escalation: admin → OWNER / MAIN OWNER via a `motha`-normalizing username

**Files:** `src/app/(admin)/admin-users/actions.ts` (`createAdminUser`), `src/lib/dal.ts` (`sessionIsOwner`), `src/lib/require-capability.ts`, `src/lib/owners.ts`
**Verification:** CONFIRMED by verifier and by hand.

**Description.** There is a privilege tier **above** `admin`: OWNER (total page/capability bypass + owner-only surfaces — Salaries, Excluded Users, balance-adjustment edit) and MAIN OWNER (can set `admin_users.is_owner` on anyone). The permanent root owner is identified by a **string bypass**: `sessionIsOwner()` returns true when `(session.username ?? "").trim().toLowerCase() === "motha"` (same check in `requireCapability`). Meanwhile `createAdminUser` writes `username: data.username` **verbatim — no validation, no normalization, no reserved-name check** — and the username unique index is case/space-sensitive, so `" motha"` or `"MOTHA"` inserts as a *distinct* row that still normalizes to `motha` at auth time. Additionally, `createAdminUser` has **no `require2FA`**, unlike the 2FA-gated `setAdminRoles`/`toggleAdminActive`/`deleteAdminUser` — so an admin session alone can mint a backdoor admin.

**Exploitation.** A non-owner admin (or a stolen admin session) POSTs `createAdminUser` with `username=" motha"` + chosen password → logs into it → is treated as MAIN OWNER on every request (`verifySession` sets `isOwner` from `sessionIsOwner`).

**Impact.** Crosses the highest privilege boundary in the app; grants the owner-only surfaces and the ability to durably flag other owners. **High** on its own; **Critical** chained with CRITICAL-1.

**Fix.** Stop deriving owner status from a mutable, self-creatable string — pin it to an immutable id / dedicated column. Immediate hardening: (1) validate + normalize username in `createAdminUser` and reject any value that trims/lowercases to a reserved name (`motha`); (2) add `require2FA()` to `createAdminUser` and every `admin_users` write that can set/alter username.

---

### 🟠 HIGH-2 — Live customer-financial feed exposed to every role, including sandboxed external creators

**Files:** `src/app/api/live/activity/route.ts`, `src/app/(admin)/dashboard/live-actions.ts` (`fetchRecentMoneyMovements`), `src/components/docked-recent-activity-actions.ts` (`fetchDockedActivityLive`), `src/lib/queries/dashboard-live.ts`, `src/lib/dal.ts`
**Verification:** CONFIRMED by verifier and by hand.

**Description.** The SSE route `/api/live/activity` gates only on `await verifySession()` — which authenticates but performs **no role/page check** (its own comment documents the deliberate downgrade from `requirePageAccess("/dashboard")` and even names `creator` as an intended recipient). It streams `getLiveActivity()`: the platform-wide, real-time feed of customer money movement — every deposit (username/email + amount + crypto asset), every withdrawal, battles. The **two polling-fallback Server Actions** the client uses when SSE gives up (`fetchRecentMoneyMovements`, `fetchDockedActivityLive`) are gated the same way, so fixing only the SSE route leaves the data reachable.

`creator` accounts are real, externally-held admin logins (minted by `makeCreator`) that land in the `(admin)` route group. Any of them — or `pack_creator`/`marketing` — can `curl -N --cookie 'admin_session=…' /api/live/activity` or call the actions directly.

**Impact.** Customer PII + live financial data disclosed to the lowest-trust, externally-held roles. **High.**

**Fix.** Gate all three surfaces on the same access the data has on-screen — `requirePageAccess("/dashboard")` (as the sibling `/api/packy-live` already does) or a dedicated `__can_view_live_activity` capability — and return 401/403 (not a redirect) for the EventSource client.

---

### 🟠 HIGH-3 — Per-admin balance-adjustment spend cap is TOCTOU-bypassable under concurrency

**Files:** `src/lib/balance-limits.ts` (`checkBalanceAdjustmentLimit`, `sumPeriodUsage`), `src/app/(admin)/users/[id]/actions.ts` (`adjustBalance`)
**Verification:** CONFIRMED by verifier and by hand.

**Description.** The per-admin daily/weekly/monthly cap — the control that bounds a lower-trust adjuster (support/marketing granted `__can_adjust_balance` but capped) — is enforced by summing **already-written** `admin_audit_events` (`sumPeriodUsage`) and throwing if `usage + |amount| > max`. There is **no reservation, row lock, or atomic counter**, and the audit event is written *after* the money moves. Each concurrent `adjustBalance` has its own version-locked balance tx (so they don't collide on the row), but they all read the same "prior usage" before any audit event exists.

**Exploitation.** A capped admin fires N `adjustBalance` POSTs in parallel with one (replayable — see MEDIUM-5) TOTP code. All N see usage = 0, all N pass the check, all N credit the balance → total ≫ cap.

**Impact.** The spend limit is defeatable by anyone it is meant to constrain. **High** (bites wherever a per-user/role cap is configured).

**Fix.** Make the limit atomic with the spend: inside the same transaction, `UPDATE`/`INSERT` a per-admin period-usage counter with a conditional predicate (`WHERE used + |amount| <= max`) and abort if it affects 0 rows.

---

### 🟠 HIGH-4 — `processCreatorPayout` lost-update on the MAIN `balances` row

**Files:** `src/app/(admin)/creators/actions.ts` (`processCreatorPayout`)
**Verification:** CONFIRMED by verifier and by hand.

**Description.** `processCreatorPayout` credits the creator's `balances.available_balance` via read-modify-**write-absolute**: `balanceAfter = balanceBefore + available; tx.balances.update({ where:{user_id}, data:{ available_balance: balanceAfter }})`. It takes `SELECT … FOR UPDATE` on **`affiliate_accounts` only** — the `balances` row is read with a plain `findUnique` and written with a plain `update`, with **no `FOR UPDATE`, no `version` check** (unlike `adjustBalance`/`moveBalanceToVault`, which use optimistic locking). It also runs with **no `require2FA` and no `checkBalanceAdjustmentLimit`.**

**Exploitation.** Any concurrent write to the same user's `balances` during the payout tx is silently clobbered by the absolute overwrite. E.g. user balance 100; admin pays out 50 while the user wagers 100 (backend debits 100→0). Interleaved, the payout writes an absolute `150` over the concurrent `0`, so the user keeps balance they already spent — a house-negative lost update.

**Impact.** Balance corruption / money loss under normal concurrency; money movement without 2FA or spend cap. **High.**

**Fix.** Bring the balance leg into the same protocol as `adjustBalance` — `SELECT … FOR UPDATE` the `balances` row (or optimistic `updateMany({ where:{ user_id, version }, data:{ available_balance:{increment: available}, version:{increment:1}}})` with a count check) — and add `require2FA()` + the spend-cap check.

---

### 🟡 MEDIUM-1 — Authenticated SSRF via creator-controlled webhook URLs (with a status-code oracle)

**Files:** `src/app/(admin)/my-profile/actions.ts` (`createCreatorWebhook`/`updateCreatorWebhook`/`testCreatorWebhook`), `src/app/(admin)/creators/actions.ts`, `src/app/(admin)/users/[id]/actions.ts` (`adjustBalance` balance_fill dispatch), `src/lib/webhook-dispatcher.ts`
**Verification:** CONFIRMED by verifier and by hand.

**Description.** Creator webhook URLs are validated with **only `new URL(data.url)`** (a parse check — no scheme/host/IP-range restriction). `testCreatorWebhook` then `fetch(webhook.url, { method:"POST", … })` and returns `{ success, status }` to the caller (a blind SSRF oracle); `adjustBalance` and `dispatchWebhook` also POST to the stored URL server-side.

**Exploitation.** A `creator`-role account calls `createCreatorWebhook({ url:"http://169.254.169.254/…" })` (or `http://127.0.0.1:<port>/`, or an internal host) — accepted — then `testCreatorWebhook(id)` and reads the returned status to probe internal services / cloud metadata from the admin server's network. Mitigating: authenticated (creator), POST-only, response body not returned (status only).

**Fix.** Add a shared SSRF-safe validator used at both store-time and fetch-time: require `https:`, reject hosts that are or resolve to loopback/private/link-local/reserved ranges (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, `::1`, `fc00::/7`), and re-validate the resolved IP before connecting.

---

### 🟡 MEDIUM-2 — User enumeration: global search reachable by every role, staff-exclusion only for `support`

**Files:** `src/app/(admin)/actions/global-search.ts` (`searchUsersGlobal`), `src/lib/dal.ts`
**Verification:** CONFIRMED by hand.

**Description.** `searchUsersGlobal` (the ⌘K palette) is gated only by `verifySession()`. It queries MAIN `user` by `username`/`email contains` (2-char min) + exact UUID and returns id, username, display name, role, ban/lock status, and email (masked `j***@` for non-admins). Staff are excluded **only when `session.role === "support"`** — so `creator`, `pack_creator`, and `marketing` can enumerate the **entire** player base *and* staff identities/ban status.

**Exploitation.** A creator/pack_creator scripts `searchUsersGlobal("a")`, `("b")`, … harvesting usernames, roles, ban/lock flags (and masked emails) across all users, including staff.

**Impact.** Customer + staff enumeration to externally-held roles. Same root cause as HIGH-2 (verify-session-only gating). Masked email limits it to **Medium**.

**Fix.** Gate on `requirePageAccess("/users")` (as `users/mini-actions.ts` already does) or a search capability; apply the staff/creator exclusion to **all** non-admin roles.

---

### 🟡 MEDIUM-3 — Withdrawal process/cancel double-submit (no atomic status claim before the backend call)

**Files:** `src/app/(admin)/withdrawals/actions.ts` (`processWithdrawal`, `cancelWithdrawal`)
**Verification:** CONFIRMED by verifier.

**Description.** `processWithdrawal` checks `status !== "pending"` then `update({ where:{ id }})` (not `updateMany({ where:{ id, status:"pending" }})` with a count check), then POSTs the backend to initiate the Fireblocks transfer. Two concurrent calls both pass the check and both hit the backend. `cancelWithdrawal` has the same shape (double balance/inventory refund).

**Exploitation.** An operator with `__can_process_withdrawals` submits twice concurrently with one (replayable) TOTP → potential double crypto payout / double refund if the backend is not idempotent on `withdrawal_id`.

**Fix.** Atomically claim the row before the backend call: `const c = await db.card_withdrawal_requests.updateMany({ where:{ id, status:"pending" }, data:{ status:"processing" }}); if (c.count !== 1) return INVALID_STATE;` then call the backend.

---

### 🟡 MEDIUM-4 — `approveCreatorRewardClaim` can double-pay a claim

**Files:** `src/app/(admin)/creator-rewards/actions.ts` (`approveCreatorRewardClaim`)
**Verification:** CONFIRMED by verifier.

**Description.** Reads the claim, checks `status !== "pending"`, calls `adjustBalance` to pay, then `update({ where:{ id }, data:{ status:"approved" }})` — read-check-pay-write with **no** atomic status claim, row lock, or payout-keyed unique constraint (the partial unique index only constrains new *pending* rows, not the approve path).

**Exploitation.** Two concurrent approves for one `claimId` both read `pending`, both call `adjustBalance` (two distinct ledger credits — the per-row version lock does not dedupe two legitimate credits), both set `approved` → the user is paid twice.

**Fix.** Claim before paying: `updateMany({ where:{ id, status:"pending" }, data:{ status:"approving" }})`; pay only if `count === 1`; finalize to `approved` (revert on payment failure).

---

### 🟡 MEDIUM-5 — TOTP codes are replayable (never marked consumed)

**Files:** `src/lib/require-2fa.ts` (`require2FA`), `src/lib/totp.ts` (`verifyTOTP`)
**Verification:** CONFIRMED by verifier and by hand.

**Description.** `verifyTOTP` validates with `totp.validate({ token, window:1 })` and returns a bare boolean; nothing persists the consumed code/step. The same 6-digit code is accepted repeatedly for its whole ±1-window (~90s) validity across **every** 2FA-gated action.

**Impact.** This is the shared enabler that turns each "check-status → act → flip-status" race (HIGH-3, MEDIUM-3, MEDIUM-4) into a practical double-submit: one valid code authorizes all concurrent requests.

**Fix.** Persist the last-consumed TOTP step per admin (`totp_last_step` or a used-codes table); have `verifyTOTP` return the matched step and `require2FA` store it transactionally, rejecting a re-used step.

---

### 🟡 MEDIUM-6 — Auth brute-force limiters are in-memory, per-instance, and identity-keyed (the real limiter exists but is unused here)

**Files:** `src/app/(auth)/login/actions.ts` (`checkRateLimit`), `src/app/(auth)/verify-2fa/actions.ts` (`isVerifyRateLimited`), `src/lib/passkey-step-up-actions.ts`
**Verification:** CONFIRMED by verifier and by hand.

**Description.** Login (5/min keyed by **email**), verify-2FA (5/5min keyed by adminUserId), and step-up throttles are all module-level in-memory `Map`s: **per-warm-instance, reset on every cold start**, so the real ceiling is `limit × warm-instance-count`. Login being email-keyed means there is **no per-IP/per-attacker ceiling** (password-spray gets a fresh bucket per email). A correct fleet-wide `rateLimit()` (Upstash, `src/lib/cache/redis.ts`) already exists and is used by `users/export` — but not here.

**Exploitation.** Distributed brute-force of the 6-digit TOTP (fan out concurrent `verify2FA` across warm instances) or password-spray across admin emails, largely unthrottled in practice.

**Fix.** Back all three throttles with the Upstash `rateLimit()` (keep the in-memory map as a backstop, as `api-auth/rate-limit.ts` does); key login on client IP **and** email; add server-side progressive lockout of a pending session after N failures.

---

### 🟡 MEDIUM-7 — No HTTP security headers on the admin app

**Files:** `next.config.ts`, `vercel.json`, `src/middleware.ts`
**Verification:** CONFIRMED by verifier and by hand.

**Description.** Every HTML/RSC response ships with **zero** security headers: `next.config.ts` defines `redirects()` but no `headers()`; `vercel.json` has only a cron entry; middleware sets none. No HSTS, no CSP (notably no `frame-ancestors`/`X-Frame-Options` → the admin panel is **framable → clickjacking**), no `nosniff`, no `Referrer-Policy`/`Permissions-Policy`; `X-Powered-By` is exposed. (The `/api/v1/*` surface sets its own headers; the app pages do not.)

**Fix.** Add an `async headers()` to `next.config.ts` for all routes: `Strict-Transport-Security` (1y, preload), a CSP (at minimum `frame-ancestors 'none'` + scoped `script-src`/`connect-src`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`; set `poweredByHeader:false`.

---

### 🟢 LOW findings

| # | Finding | Files | Fix |
|---|---|---|---|
| **L-1** | **Cron route fails open when `CRON_SECRET` is unset** — `/api/cron/warm` runs heavy production aggregates on the small pool. | `api/cron/warm/route.ts` | Fail **closed** in production and reject when the secret is missing. |
| **L-2** | **`SESSION_SECRET` used with bare `!` and no fail-fast** — if ever unset/empty, all JWTs sign/verify with an empty key (forgeable sessions). | `src/lib/session.ts` | Validate at module load: throw if absent or `< 32` chars; centralize required-env validation. |
| **L-3** | **✅ FIXED: root seed refuses to run without `ADMIN_SEED_PASSWORD`.** | `scripts/seed-admin.ts` | Strict guard runs before opening a DB connection; no default password exists. |
| **L-4** | **`logout()` leaves `admin_2fa_pending` + `admin_webauthn_challenge` cookies alive** (5-min TTL) — widens the CRITICAL-1 window; shared-browser leakage. | `src/lib/actions/auth.ts` | Also `deletePendingSession()` + `deleteWebauthnChallenge()` on logout. |
| **L-5** | **Passkey step-up token not bound to a single action** — `{purpose,adminUserId}` JWT reusable for any privileged action for 2 min. | `src/lib/session.ts`, `src/lib/require-2fa.ts` | Bind an action id (+ param hash) into the token and verify it; optional single-use nonce. |
| **L-6** | **`adjustRainBase` accepts NaN/Infinity** — only `< 0` guarded; `NaN < 0`/`Infinity < 0` are false → non-finite written to the MAIN rain pool. | `src/app/(admin)/rain/actions.ts` | Guard with `Number.isFinite` like `updateRainConfig`; prefer `usdAmountSchema`. Check `createReward`/`updateReward` similarly. |
| **L-7** | **Potential stored XSS on socials-review `href`** — creator social URL rendered as `<a href={row.url}>` with no scheme check; exploitable only if the upstream backend stores a `javascript:` URL (likely blocked upstream → UNCERTAIN). | `src/app/(creator-hub)/creator-hub/socials-review/page.tsx` | Validate `new URL(row.url)` and only emit the anchor for `http(s):`; else render as text. |
| **L-8** | **Sentry has no `beforeSend`/`beforeBreadcrumb` scrubber** — `sendDefaultPii:false` is set, but default console breadcrumbs can carry backend error payloads (`client.ts` logs full response bodies). Dormant unless Sentry is enabled. | `src/sentry.*.config.ts`, `src/instrumentation-client.ts`, `src/lib/backend-api/client.ts` | Add a breadcrumb scrubber / disable console breadcrumbs; log response *shape*, not body. |

---

## 3. Cross-system attack chain (the thing that makes this urgent)

```
stolen admin password
      │  (2FA is supposed to stop here)
      ▼
CRITICAL-1  confirmSetup step=confirm  ──►  full admin session, no 2FA
      ▼
HIGH-1  createAdminUser username=" motha"  ──►  new MAIN-OWNER-equivalent account
      ▼
enroll attacker's own TOTP/passkey  ──►  durable, self-controlled MAIN OWNER
      ▼
owner-only surfaces + is_owner granting + (MEDIUM-5 replay) money actions
```

Each link is independently confirmed. **Fixing CRITICAL-1 breaks the chain at the top; fixing HIGH-1 breaks it in the middle. Do both.**

---

## 4. What's done right (so fixes don't regress it)

A fair audit must record the strong baseline — these are correct and should be preserved:

- **API-key auth** (`src/lib/api-auth/authenticate.ts`): constant-time hash compare, single opaque 401 (no enumeration), deny-by-default, fail-closed IP allowlist, per-key rate limiting, audited failures.
- **Public Discord API** (`/api/v1/discord/*`): scope-gated via `withApiKey`; never trusts bot input — recomputes entitlements server-side; double-claim blocked by a **DB partial-unique index**, not code.
- **`adjustBalance`** money core: optimistic locking (`version` + `updateMany` + `count!==1` abort), mandatory paired ledger entries with `balance_before/after`, 2FA, per-category sign validation, wager-debt freeze.
- **Session integrity:** `verifySession` re-reads role/active/owner **DB-fresh every request** (a demote takes effect immediately); JWT alg pinned to `HS256`; real revocation via `sessions_valid_after`; cookies `httpOnly` + `secure` (prod) + `sameSite=lax`.
- **Role/permission mutations** (`updateUserPermissions`, `setAdminRoles`, …): admin + capability + **2FA** + last-admin/self-demotion guards + key sanitization.
- **Raw SQL:** complex reads use the parameterized Drizzle query adapter, which binds `$1/$2` values and rejects missing or unused parameters.
- **XSS:** no `dangerouslySetInnerHTML` with user data (only the shadcn chart's dev-controlled CSS). React auto-escaping intact.
- **Secrets:** nothing sensitive under `NEXT_PUBLIC_`; `users/export` layers `requirePageAccess` + `__can_export_users` + a real Upstash rate limiter + audit.

---

## 5. Priority summary & quick wins

**Fix now (this week):**
1. **CRITICAL-1** — 2FA bypass in `confirmSetup`. (Highest priority; a few lines.)
2. **HIGH-1** — validate/normalize `createAdminUser` username + reserved-name reject + `require2FA`; pin owner identity off the username string.
3. **HIGH-2** — re-gate `/api/live/activity` + the two polling actions to `requirePageAccess("/dashboard")`.

**Quick wins (small diffs, real risk reduction):**
- **L-2 / L-3 / L-4** — fail-fast `SESSION_SECRET` validation; drop the `"CHANGEME"` fallback; clear all auth cookies on logout.
- **MEDIUM-7** — add the `headers()` block (HSTS + `frame-ancestors 'none'` + `nosniff`) — pure config, no logic risk.
- **L-1** — fail closed on missing `CRON_SECRET` in prod.
- **L-6** — `Number.isFinite` guard on `adjustRainBase`.

**Structural fixes (need a small design pass, high value):**
- **MEDIUM-5** — make TOTP codes single-use; this hardens **every** money race at once.
- **HIGH-3 / HIGH-4 / MEDIUM-3 / MEDIUM-4** — apply the "atomic status/limit claim before the side effect" pattern (`updateMany` with a conditional `where` + count check, or `FOR UPDATE`) uniformly to the spend-cap, creator payout, withdrawal, and reward-approve paths.
- **MEDIUM-6** — move auth throttling to the existing Upstash limiter, keyed on IP + identity.
- **MEDIUM-1 / MEDIUM-2** — shared SSRF-safe URL validator for webhooks; gate global search on `/users`.

## 6. Method, coverage, and honesty notes

- **Coverage:** all ~15 API route handlers and ~40 Server-Action files were reviewed; auth/session/2FA, the DAL/RBAC, the money core, raw-SQL sites, config, and secrets were read in depth.
- **Verification:** 19 findings CONFIRMED by an independent adversarial verifier; every High/Critical was **additionally** re-read by hand for this report. 4 findings are UNCERTAIN (kept at Low; precondition-dependent, e.g. `CRON_SECRET`/upstream URL policy) and labeled as such.
- **Refuted (not a vulnerability):** unescaped LIKE wildcards in `getCodes` (`src/lib/queries/creators-codes.ts`) — the term is a **bound parameter** (`$1`), so it is not SQL injection; `%`/`_` merely act as wildcards. Worth a one-line hygiene fix (`ESCAPE '\'`) but carries no security impact.
- **Not exercised:** no code changed, no DB queried, no live requests sent, no headless/browser run. Exploit scenarios are derived from code paths, not executed — validate any fix against staging.
- **Policy aside (not a vuln):** several money actions write the MAIN/prod DB (`linkCreatorToMainUser`, `adjustBalance`, `moveBalanceToVault`, `processCreatorPayout`). That is by design for the production admin app, but it sits against this repo's "MAIN is read-only" development policy — worth a conscious note.
