# Antifraud quality and contract audit

Date: 2026-07-30
Scope: repository code and migrations at `2f194f21`
Safety boundary: no MAIN writes, production queries, migrations, infrastructure changes, push, or deployment

## Authoritative owner contract result

The owner contract is the target. The current branch is not conformant and must
not be released as the requested recode without resolving the divergences below.

| Owner requirement | Current branch | Result |
|---|---|---|
| Risk is always 0–100 | Signup/session/case scores can exceed 100 and severity includes 120+ critical | Diverges |
| 0–20: no Discord or continuous monitor; global hard guards remain | Default monitor starts at 25 and Discord starts at 60, but most named hard guards only add score | Partial |
| 30-second signup stabilization | Signup cursor waits 5 seconds | Diverges |
| 10-minute standard and 15-minute high monitor | One configurable duration defaults to 180 seconds | Diverges |
| Fiat off by default | No explicit true-only account/environment switch exists; missing lock state is treated as unlocked, and a previously cached allow returns before current account policy is loaded | Direct conflict |
| Fingerprint Pro Plus, ProxyCheck v3, Abstract IP/email, Opportify required | All five are required; ProxyCheck version/tag and provider timeouts are explicit | Conforms |
| Provider failures never clean | Failed required providers dead-letter and retry; missing provider input is scored/skipped instead of treated as an outage | Mostly conforms |
| Retain overlaps but cap one underlying fact | Overlapping evidence is retained and some provider-local duplicates score zero, but signup totals sum every signal without fact-group caps | Diverges |
| Sanitized Sumsub KYC | Sanitized country/review/document evidence is bounded; raw identity documents are not persisted | Conforms |
| Permanent profiles and versioned evidence | `subjects`, `signup_assessments`, and provider rows are mutable current-state records; signup has no model version | Diverges |
| Missing fingerprint differs from provider outage | Missing request ID becomes a scored `fingerprint_missing`; provider call failure dead-letters | Conforms |
| OAuth credential provider plus later Discord link | Signup source has no Google/Discord/Steam credential or later-link evidence | Not implemented |
| IPv4 exact and IPv6 exact plus /64 clustering | Exact IP and device exist; signup IPv6 /64 exists; network graph masks IPv6 to /64 and does not retain separate exact-/64 edges | Partial |
| Catch-all bans and adds domain/IP/fingerprint blocklists | Current catch-all locks the account and withdrawals, then auto-requires KYC; no operator blocklist tables exist | Direct conflict |
| Domain blocklist bans | Current domain match locks withdrawals and auto-requires KYC | Direct conflict |
| IP/fingerprint blocklist locks and reviews | No operator IP/fingerprint blocklist contract exists | Not implemented |
| Third exact IP/fingerprint account in 30 days locks newest and reviews | Current IP windows are 10/30 minutes; device is all-time score-only; no newest-account lock | Not implemented |
| CZ/SK/SI/IN are context only | Risky locations are editable and add 20 score points | Diverges |
| VPN moderate, datacenter high, proxy very high | Provider weights broadly order network risk but are not a single authoritative classification policy | Partial |
| Tor plus confirmed VM locks immediately | Tor and VM score independently; no combined containment command | Not implemented |
| Bad bot, anti-detect, replay, mismatch are hard guards | Signals score strongly but do not have dedicated immediate containment actions | Diverges |
| Lock balance and item withdrawals | Containment sets crypto/balance withdrawal `all` and item withdrawal lock | Conforms |
| No automatic KYC except existing explicit hard policy | Email-domain, catch-all, and free-battle containment all auto-require KYC | Direct conflict |
| Locked review may manually KYC; normal review may not | Account Review actions are Fine, Ban, and Lock withdrawals; no locked-only KYC action exists | Not implemented |
| Reward rush includes Welcome 3-pack and level-0 Level 1 | Exact reward IDs and the welcome-plus-Level-1 rule exist | Conforms |
| Third promo on a fresh account locks | Promo redemption is observed but no third-promo rule or containment exists | Not implemented |
| Creator tip/free sponsored battle before deposit is very high | Both default sequence rules add 40; global free-battle graph starts at 40 and contains at 80 | Diverges |
| Creator-only funded sponsorship excluded from normal players | Sponsorship detection uses sponsorship percentage or source session and lacks an explicit creator-only funding exclusion | Unproven/diverges |
| Unified relationship/fund graph | Exact IP/device, affiliates, creator wallets, battles, and withdrawal funding exist in separate models; no unified downstream/session-hopping graph | Partial |
| Historical data additive, idempotent, unknown never clean | Delivery and action idempotency are strong, but signup/provider evidence is overwritten and backfills can delete history | Diverges |
| Discord exact categories/channels/team IDs/reminders | Signed routed transport exists; the exact external transport-workstream contract was not included in this worktree request | Pending external contract |
| Webapp routes/tabs/actions/error states | Current Fraud routes and errors were inventoried; the exact UI-workstream contract was not included | Pending external contract |
| API/WS auth, replay, recovery, heartbeat, backpressure, degraded health | Token separation, tickets, actor limits, Redis replay, SSE recovery, heartbeat, buffered-byte termination, and degraded health exist | Conforms |
| Append-only audit and server-side permissions | Permissions are server-side; several audits are repairable/idempotent, but mutation-then-secondary-audit paths can leave audit gaps | Partial/diverges |
| External frontend/backend out of scope; MAIN read-only | This audit made no external-repository or production changes; runtime mirror reads are read-only | Conforms |

## Current end-to-end implementation

1. `antifraud-monitor` reads signups and activity from the read-only MAIN mirror.
2. Every signup requires Fingerprint, ProxyCheck, Abstract IP, Abstract email, and Opportify enrichment.
3. Provider failures are stored in `provider_checks`, dead-letter the signup, advance the source cursor atomically with the failure, and remain replayable.
4. Confirmed email blacklist and Abstract catch-all containment are persisted before unrelated provider failures can block them.
5. Signup signals produce one current assessment. Scores at 25+ start monitoring by default. Scores at 60+ open Account Review and enqueue Discord even though the generic severity remains `medium` until 80. This is current behavior, not proof of the owner’s 0–100/timing policy.
6. Live activity is read per active monitor session, deduped by `(source, source_ref)`, scored in an Antifraud transaction, and evaluated against sequence rules only within that session.
7. Reward-rush rules stop at a fiat or crypto deposit. They cannot combine events from different monitor sessions.
8. Restricted-account relationships enter through device/IP/signup clusters, account-network scans, suspicious deposit clusters, restricted funding traces, and global sponsored/free-battle joins.
9. Authoritative signals travel through signed dashboard ingest into ADMIN cases. Live visibility travels through ticketed WebSocket, Redis replay, a same-origin/rate-limited SSE proxy, and snapshot recovery.
10. Discord events travel through the signed ADMIN queue with a guild pin and dedupe key. Monitor outboxes retain retry state.
11. Fraud pages and live APIs share `requireAntifraudAccess`. Manager mutations use the service admin token. Refunds are owner-only and require fresh step-up.
12. Refund payment IDs are globally unique in ADMIN. Whop SDK retries are disabled. Any outcome that may have reached Whop is quarantined as `unknown`.

## Findings

### High

- The authoritative 30-second stabilization and 10/15-minute monitoring windows are absent. Current defaults are 5 seconds and 3 minutes.
- Signup risk is not capped to 100. Raw signal totals flow into assessment, session, case, severity, and rule deltas.
- Fiat eligibility is not default-disabled. Missing per-user state resolves to unlocked, and the idempotent cached-decision path can replay a prior allow before re-reading current account/environment policy.
- Current auto-KYC behavior directly conflicts with the owner contract. Email blocklist, Abstract catch-all, and risky free-battle containment call `requireUserKyc`.
- Catch-all and domain-blocklist actions conflict with the owner contract: they lock/KYC instead of ban plus maintaining the required evidence blocklists.
- Signup history is not versioned. `signup_assessments` has one row per user and an upsert overwrites score, severity, signals, and assessment time. A later weight change or replay cannot distinguish the old model from the new one.
- Provider evidence is not append-only. `provider_checks` is unique on `(user_id, provider, lookup_key)` and `saveProviderCheck` overwrites the prior status, score, signals, response, error, and timestamp. An expired successful lookup followed by a failure can erase the last successful evidence.
- Signed containment runs MAIN mutations and backend KYC calls while an ADMIN transaction is open. That is a cross-database/network call under an ADMIN transaction and can hold locks through an external outage. It also collides with the earlier audit hardening goal of avoiding cross-DB work under review locks.
- Refund account recovery commits MAIN changes before the secondary ADMIN audit mirror. The UI reports audit failures, but a successful mutation can still exist without its expected ADMIN audit row. Other KYC and Fiat actions have the same secondary-audit durability pattern.

### Medium

- Permanent user profiles, OAuth/credential provider evidence, later Discord links, operator IP/fingerprint blocklists, third-account 30-day containment, third-promo containment, and locked-review-only KYC are absent.
- Risk-country rows currently add 20 points, contradicting context-only treatment for CZ/SK/SI/IN.
- Tip and sponsored-battle rules add 40 rather than the owner’s very-high action. The free-battle flow auto-KYCs at its second-battle threshold, which is also prohibited by the new contract.
- The relationship systems are fragmented. Account networks cover exact IP/device, creator analysis adds affiliate/wallet evidence, free battles are separate, and withdrawal funding is separate. Session hopping and downstream value movement are not unified.
- Applied migrations store only filenames, not checksums. Editing an already-applied SQL file is silently ignored and schema drift cannot be detected by the runner.
- Backfill migrations have no executable pre/post count, duplicate, parity, or post-commit recovery assertions. `014_signup_live_behavior_tuning.sql` deletes legacy weights, `022_split_high_risk_fiat_destination.sql` deletes delivery rows, and `028_dashboard_delivery_receipts.sql` changes historical delivery state.
- Signup and Fiat assessments overwrite the current row. Withdrawal assessments correctly retain `model_version=1` for legacy rows and filter current reads to version 4, but the same historical model contract is absent for signup.
- Unknown historical provider payloads are handled inconsistently. Fingerprint can reuse stored signals, Opportify refetches when parsing fails, while cached ProxyCheck/Abstract parsing can reject the whole signup replay.
- The mirror index bundle has no dedicated `(user_id, created_at)` coverage for sponsored `battle_participants`, and no expression/time indexes for affiliate-code or country signup clustering. Those reads are time bounded but may become repeated scans under signup bursts or many active sessions.
- The migration sequence contains duplicate numeric prefixes (`002`, `003`, `014`, `018`, `022`). Full filenames keep ordering deterministic, but operator references such as “migration 014” are ambiguous.

### Integration collisions

- Score 60 is a deliberate review/Discord threshold while generic severity 60 is medium. Consumers must use `high_risk_signup` plus score, not severity alone.
- Account Review has both ADMIN-native reviews and monitor-service cases. Idempotency and audit repair exist on each side, but they are not one distributed transaction.
- Discord has monitor outboxes, signed dashboard enqueue, ADMIN routing jobs, and bot delivery. Acknowledging one hop must never be described as delivered to Discord.
- Replaying containment after delivery-receipt changes is intentionally different from ordinary event backfill. Generic parity tooling must preserve that exception.
- Refund provider success and account recovery are separate durable outcomes. Retrying recovery is safe; retrying an `unknown` provider refund is not.

## Migration and backfill production verification

Run these checks against Antifraud or ADMIN only. Use the MAIN mirror only for bounded read parity. Do not run them against MAIN primary.

### Before

- Capture `schema_migrations` filenames and applied times.
- Capture exact row counts for every table touched by the migration.
- Capture duplicate counts for each target unique key.
- Capture counts grouped by model/version, status, provider, delivery state, and source kind.
- Save the exact candidate key set for any `UPDATE` or `DELETE`.
- Run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` only for bounded mirror reads and confirm the expected index plus row/time bounds.

### Apply or rerun

- Apply under the existing advisory lock and per-file transaction.
- Rerun the migration command. It must perform zero SQL changes because the filename is already recorded.
- Verify no applied filename is missing and no untracked numeric SQL file exists.
- Until checksums are implemented, separately hash the deployed SQL files and retain the manifest with the release evidence.

### After

- Re-run all counts and duplicate checks.
- Assert untouched history counts are identical.
- Assert legacy withdrawal rows remain model 1 and new/current rows are model 4.
- Treat missing signup model version and overwritten provider rows as a release blocker for any future historical signup rescore/backfill.
- For delivery backfills, compare delivered, pending, and intentionally replayed counts separately.
- For refunds, verify one item per provider payment ID and preserve `unknown` without automated retry.
- Sample deterministic IDs from before and after, then compare all non-target columns.

### Rollback and recovery

- A failure inside a migration must leave no `schema_migrations` row and no partial writes.
- Before a post-commit data backfill, prepare a forward recovery statement keyed by the captured candidate IDs. Do not rely on a destructive down migration.
- For Discord delivery changes, restore state from the captured per-destination rows, not aggregate outbox flags.
- For assessment rescoring, insert a new model-versioned record. Do not rewrite legacy evidence.
- For provider normalization, retain the raw sanitized historical record and write normalized evidence separately.

## Test matrix

| Area | Executable coverage | Result |
|---|---|---|
| Owner target divergence | Timing, score cap, Fiat default/cached allow, profiles, KYC, blocklists, identity evidence, countries, promo/tip/sponsorship, review actions | Added explicit sentinels |
| Signup providers | Five required providers, failure replay, catch-all-before-failure | Added |
| Thresholds | 25 monitor default, 60 review/Discord, 80 high, 120 critical | Added/existing |
| Provider failures | Dead-letter replay and poller recovery | Existing plus added contract |
| Restricted relationships | Device/IP clusters, networks, funding trace, free-battle scoring | Existing |
| Reward rush | Deposit exclusion, exact reward events, session-bound sequences | Added |
| Session hopping | Rule query is pinned to one `session_id`; WebSocket limits use staff actor | Added/existing |
| WebSocket/API recovery | Ticket, reconnect, replay cursor, capacity-safe SSE, snapshot fallback | Added/existing |
| Discord delivery | Signed queue, guild pin, dedupe, durable retry outboxes | Added/existing |
| Permissions | Workspace gate, manager admin token, owner refund gate | Added/existing |
| Audit durability | Local transaction/idempotency coverage; cross-store gaps documented | Partial |
| Refund safeguards | Fresh step-up, retrieve-before-refund, no SDK retry, unknown quarantine | Added/existing |
| Migration rerun | Advisory lock, per-file transaction, filename idempotency | Added |
| Legacy versions | Withdrawal v1/v4 and Fiat v1/v2 | Added |
| Backfill parity/counts | Production runbook prepared; not executed | Prepared only |
| MAIN mirror bounds | Time/ID limits and existing ledger/reward indexes | Added |
| Rollback/recovery | In-transaction rollback covered; post-commit recovery gap documented | Partial |

The `owner-contract-divergence.test.ts` suite intentionally passes only while
the named divergence is present. When an implementation workstream fixes one,
its sentinel must fail and be replaced with a positive contract test for the
new behavior.
