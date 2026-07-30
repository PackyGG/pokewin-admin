# Antifraud system map and recode blueprint

Status: current-source map, prepared 2026-07-30.

This document maps the fraud system owned by `PackyGG/pokewin-admin`. It covers
the Fraud webapp, the repository-contained `antifraud-monitor`, the dashboard
ingest and Discord delivery APIs, and the contracts used by the external bot
and game backend.

The separate bot and game-backend repositories are not implementation scope.
Their exact HTTP contracts are included so their changes can be handed off
without guessing.

## 1. Hard boundaries

- MAIN game data is a source. Fraud reads it through the read-only mirror.
- Antifraud detections, assessments, cases, cursors, and delivery state belong
  in the Antifraud database.
- Staff identity, staff review projections, audit history, Discord routing,
  and Discord jobs belong in the ADMIN database.
- Account mutations must use an explicit application mutation boundary.
  The target design removes direct MAIN DML from fraud ingestion.
- Redis is live transport only. PostgreSQL remains the durable record.
- Discord is an output, never a system of record.
- Provider data is evidence. Provider errors must not silently become clean
  decisions.

## 2. Current topology

```text
MAIN mirror
  | signups, fingerprints, audit activity, ledger, fiat, battles, locks
  v
antifraud-monitor
  |-- provider enrichment: Fingerprint, ProxyCheck, Opportify
  |-- KYC enrichment: Sumsub (current working-tree integration)
  |-- signup/session/rule scoring
  |-- fiat, withdrawal, network, creator, free-battle assessments
  |-- Antifraud DB: evidence, cases, assessments, cursors, outboxes
  |-- Redis: live events
  |
  | signed risk-event delivery
  v
Next.js /api/antifraud/ingest
  |-- ADMIN DB: antifraud_signals, antifraud_reviews, notes
  |-- current containment: MAIN lock plus backend KYC call
  |
  | signed Discord-event delivery
  v
Next.js /api/antifraud/discord-events
  |-- ADMIN DB: event routes and durable jobs
  v
Discord bot
  |-- channel inventory sync
  |-- job claim lease
  |-- Discord send
  `-- delivered/failed acknowledgement
```

There are currently two related case models:

- Antifraud DB `cases`: detection/session case with events, provider evidence,
  rule matches, network members, and monitor decisions.
- ADMIN DB `antifraud_reviews`: staff queue projection with assignment, notes,
  quick actions, and terminal staff outcomes.

## 3. Webapp feature inventory

### Fraud workspace

| Surface | Current purpose | Main implementation |
|---|---|---|
| Overview | Lifetime business totals and recent fraud state | `src/app/(antifraud)/antifraud/page.tsx`, `src/lib/antifraud/overview.ts` |
| Signups | Signup assessments, scores, signals, attention filters | `signups/page.tsx`, `src/lib/antifraud/signups.ts` |
| Live Monitor | Active sessions and live Redis-backed event feed | `monitor/*`, `_components/monitor-stream.ts`, dashboard monitor APIs |
| Monitor case | Full detection evidence, rule matches, sessions, network members, decision | `monitor/cases/[id]/*`, `src/lib/antifraud/monitor-api.ts` |
| Account Review | Durable staff queue, priority/normal/waiting-KYC/postponed projection, modal review, assignment, notes, quick actions, status | `reviews/*`, `src/lib/antifraud/reviews.ts`, `src/lib/antifraud/review-workflow.ts` |
| Fiat Deposits | Canonical fiat assessments, evidence, review status, KYC action | `fiat-deposits/*`, `src/lib/antifraud/fiat-deposits-api.ts` |
| Fiat Fraud | MAIN-derived fraud/payment investigation list | `fiat-fraud/*`, `src/lib/queries/fiat-fraud.ts` |
| Withdrawals | Withdrawal score, provenance trace, linked restricted accounts, review | `withdrawals/*`, `src/lib/antifraud/withdrawals-api.ts` |
| KYC | Active/waiting and finished-history KYC views with sanitized Sumsub evidence | `kyc/*`, `src/lib/antifraud/kyc.ts`, `src/lib/antifraud/sumsub-review-api.ts` |
| Whop Refunds | Owner-only, step-up protected, leased and auditable refund batches | `refunds/*`, `src/lib/queries/whop-refunds.ts` |
| Account Networks | User-linked IP/device/account graph and rescan | `networks/*`, `src/lib/antifraud/network-api.ts` |
| Profiles | Permanent per-user assessments, providers, relationships, restrictions, and blocklist evidence | `profiles/*`, monitor profile API |
| Banned Users | Current banned-account workspace with audited ban/reactivate controls | `banned-users/*`, monitor banned-user API |
| Risky Locations | Evidence-only country policy, weight, expiry, stats, and monitor window | `risky-locations/*`, monitor risky-location API |
| Email Blacklist | Domain rules, matches, Gmail-pattern and cluster containment evidence | `email-blacklist/*`, monitor email-domain API |
| IP Blacklist | Canonical IPv4/IPv6 exact and CIDR rules, history, metrics, affected profiles | `ip-blacklist/*`, monitor identifier-blocklist API |
| Fingerprint Blacklist | Exact device rules, history, metrics, affected profiles | `fingerprint-blacklist/*`, monitor identifier-blocklist API |
| Risk Scoring | Editable weights and analysis rules | `points/*`, `src/lib/antifraud/monitor-api.ts` |
| Events & Triggers | Live/planned event vocabulary | `events/*`, monitor `event-catalog.ts` |
| Custom Flows | Ordered event sequences, exclusions, score and outcome | `flows/*`, monitor rule endpoints |
| Discord Routing | Bot-synced channels and event-to-channel assignments | `webhooks/*`, `src/lib/discord-notifications/router.ts` |
| API | Integration documentation/status | `api/page.tsx`, `settings/api/page.tsx` |
| Settings | Access rules and integration status | `settings/*`, `src/lib/antifraud/access.ts` |

### Related surfaces outside the Fraud sidebar

- Creator Fraud lives in the Marketing/Creator Hub app. It assesses referred
  account cohorts and their networks, not the creator's own play.
- User detail exposes KYC and fraud locks and links into fraud evidence.
- Normal withdrawal lists show Fiat-funding provenance badges.
- Fraud navigation badges track unseen signups, reviews, and Fiat work.
- Legacy review, network, creator-fraud, notification, and refund URLs redirect
  to their current owning workflow.

### Access model

- Owners always have Fraud access.
- Admins have Fraud access and management access.
- Support, marketing, and creator-manager access can be enabled per role.
- Username allow/deny lists are owner-managed.
- Dedicated pack builders are denied.
- Reads fail closed when the access configuration is unavailable.
- Refund execution is owner-only.
- Domain, IP, fingerprint, banned-user, and risk-location operations are
  available to every verified Fraud user and remain reasoned, confirmed,
  idempotent, and audited. Settings, scoring, flows, and routing remain
  owner/admin-only.

## 4. Repository-contained backend inventory

### Runtime and infrastructure

| Module | Responsibility |
|---|---|
| `server.ts` | Fastify composition root, auth hooks, health, API routes, lifecycle |
| `config.ts` | Environment validation |
| `db.ts` | Antifraud DB, production mirror, optional dev eligibility mirror |
| `migrate.ts` | Ordered Antifraud DB migrations |
| `live.ts` | Redis publish/replay, websocket fanout, one-time tickets |
| `poller-health.ts` | Leader/tick/backlog/failure health state |
| `auth.ts` | Service/admin token comparison and route authorization |
| `route-helpers.ts` | Common API error and request helpers |

### Detection and assessment engines

| Module | Responsibility |
|---|---|
| `monitor.ts` | Leader-elected signup poller, live behavior sessions, rules, alerts |
| `scoring.ts` | Base signup signal scoring and severity |
| `score-catalog.ts` | Editable score vocabulary and defaults |
| `score-weight-store.ts` | Cached weights and audited idempotent updates |
| `event-catalog.ts` | Live/planned behavior event vocabulary |
| `enrichment.ts` | Fingerprint, ProxyCheck, Abstract IP/email, and Opportify parsing, weighting, caching |
| `network-risk.ts` | Account graph, creator-cohort fraud, async scan jobs |
| `fiat-risk.ts` | Fiat evidence, score, verdict, assessment persistence |
| `fiat-eligibility.ts` | Synchronous automatic checkout allow/deny decision |
| `withdrawal-risk.ts` | Withdrawal provenance, flow checks, linked-account risk |
| `free-battle-risk.ts` | Global sponsored/free-battle relationship detection |
| `fiat-email-domains.ts` | Domain, Gmail-pattern, and deposit-cluster detection |
| `fiat-withdrawal-holds.ts` | Existing automatic Fiat withdrawal-lock discovery |
| `risky-locations.ts` | Country policy lookup |
| `sumsub-client.ts` | Sumsub applicant review lookup (uncommitted integration) |

### Delivery and recovery

| Module | Responsibility |
|---|---|
| `ordered-ingestion.ts` | Preserve source order while preparing concurrently |
| `signup-failure.ts` | Serialize/parse signup dead-letter payloads |
| `outbox.ts` | Shared retry calculation and outbox draining helper |
| `signup-alerts.ts` | High-risk signup marker construction |
| `ingest-delivery.ts` | Signed batch delivery of `risk_events` to the dashboard |
| `discord-events.ts` | Signed event enqueue request to dashboard Discord router |
| `discord.ts` | Legacy/common antifraud Discord embed builder and sender |
| `fiat-alerts.ts` | Fiat problem capture, per-destination rows, Discord delivery |
| `notification-routes.ts` | Current notification families and route status |
| `decision-idempotency.ts` | Stable decision replay identity |
| `rule-idempotency.ts` | Stable rule mutation replay identity |

## 5. Monitor execution flow

### Startup

1. Validate all environment configuration.
2. Create Antifraud, MAIN-mirror, and optional dev-mirror pools.
3. Apply Antifraud DB migrations.
4. Verify the Antifraud DB.
5. Preload the disposable-email list.
6. Subscribe the Redis live bus.
7. Start signed dashboard delivery.
8. Start the network scan worker.
9. Start withdrawal assessment synchronization.
10. Start the HTTP server.
11. Retry monitor-poller startup until the source mirror is available.

### Leader tick

One replica obtains the PostgreSQL advisory leader lock. Each phase is isolated
so one failed phase does not suppress later cleanup.

1. Replay dead-lettered signups.
2. Read and assess new signups in cursor order.
3. Detect automatic Fiat withdrawal holds.
4. Deliver high-risk signup alerts.
5. Deliver matched-rule alerts.
6. Detect email-domain, Gmail-pattern, and deposit-cluster risk.
7. Deliver Fiat-withdrawal-hold alerts.
8. Detect and deliver Fiat lifecycle/risk problems.
9. Detect global free/sponsored-battle relationships.
10. Read live behavior for active signup monitor sessions.
11. Evaluate ordered custom flows.
12. Complete expired sessions.
13. Record health, lag, backlog, and pending dead letters.

### Signup flow

1. Read a bounded cursor page from the MAIN mirror.
2. Upsert a subject snapshot.
3. Capture email containment evidence before external providers.
4. Load signup/account context and editable weights.
5. Fetch or reuse Fingerprint, ProxyCheck, Abstract IP Intelligence, Abstract
   Email Reputation, and Opportify evidence. Opportify
   receives only the signup fields its private server API supports and adds
   independent email, IP, username-content, velocity, and geographic evidence;
   no Fingerprint result or internal fraud state is sent to it.
6. Fail to the durable signup dead-letter when required enrichment is
   unavailable.
7. Score base, provider, and risky-location signals.
8. Persist assessment, case/session, high-risk marker, catch-all containment,
   outbox, and source cursor transactionally.
9. Broadcast committed live events.
10. Queue an account-network scan.
11. Evaluate custom flows against the opened session.

### Live behavior flow

1. Read active monitor sessions.
2. Read new ledger/reward/game activity with a bounded overlap.
3. Normalize source rows into catalog event keys.
4. Apply score deltas and persist risk events.
5. Evaluate each enabled ordered flow once per session.
6. Update the case score/severity and outbox any configured review alert.
7. Advance the per-session activity cursor.

### Fiat flows

- Assessment: load intents plus account, funding, behavior, provider, and
  network evidence; score by category; store one canonical assessment.
- Eligibility: authenticate by environment-specific credential and source IP;
  validate user and Fingerprint event; refresh provider/network evidence;
  enforce locks and KYC; store a fresh allow/deny decision; fail closed.
- Lifecycle alerts: cursor failed/review/disputed/refunded/stale payments and
  failed webhooks; merge canonical bad assessments; route by event family.
- Email risk: match configured domains, Gmail aliases, and coordinated
  same-amount clusters; persist evidence and create containment events.
- Abstract signup email: validate deliverability, SMTP/MX, catch-all,
  disposable, username, quality, age/TLD, and address/domain risk. Catch-all
  results require KYC and lock crypto/item withdrawals through signed ingest.

### Withdrawal flow

1. Incrementally synchronize source withdrawal requests.
2. Reconstruct the requested amount backwards through ledger credits.
3. Classify funding as deposit, play return, reward, creator tip, sponsored
   battle, voucher borrowing, or unresolved trace gap.
4. Enrich linked accounts for locks, KYC, ban, alt, self-exclusion, ADMIN tag,
   active Fraud case, and Account Review state.
5. Evaluate rapid cashout, confirmation, destination reuse, attached assets,
   account age, funding gap, and linked-risk signals.
6. Persist a versioned assessment and review trail.

### Free/sponsored-battle flow

1. Build the set of creators with rejected/fraud KYC, suspected-alt state, or
   active Antifraud risk.
2. Scan each creator from a durable cursor.
3. Record deduplicated participant/battle relationships.
4. Score distinct qualifying battles at the current 40/80/120 bands.
5. Open/update the monitor case.
6. At the containment threshold, persist a signed containment event.
7. Deliver the event to dashboard ingest and Discord.
8. Mark delivery only after the dashboard confirms the full batch.

## 6. Case, action, and containment flows

### Monitor case decision

- The dashboard submits an idempotent decision to the monitor API.
- The monitor records a `staff_actions` row and updates the Antifraud case.
- The dashboard mirrors decision audit into the ADMIN review workflow.
- The current split means staff state must be reconciled across two stores.

### Account Review

- Signed ingest inserts an idempotent ADMIN `antifraud_signals` row.
- High/critical signals and score-60 signup markers open or merge one live
  review per user.
- The signed operations tick projects each live review into one staff queue:
  `priority` for a withdrawal lock, finished provider KYC, or risk 70+;
  `waiting_kyc` for an unfinished required cycle; otherwise `normal`.
- An explicit staff postponement overlays `postponed` for 2.5 hours, suppresses
  reminders until due, and writes the review trail plus ADMIN audit atomically.
- Staff can assign, note, mark fine, flag, ban, or lock withdrawals according
  to capability.
- Managers can request KYC only when the account is currently fully locked;
  the mutation rechecks this against the owning application boundary.
- Status updates use idempotency and audit rows.
- The queue remains visible while the case opens in a dialog.

### Automatic containment

Current dashboard ingest treats two signal kinds as commands:

- `fiat_blacklisted_email_domain`
- `risky_free_battle_containment`

For first delivery only, it locks withdrawals in MAIN and may require KYC
through the game backend. This mixes event projection with side effects and
crosses database/API boundaries inside the ADMIN transaction.

Target behavior: ingest only persists and projects the event. A dedicated,
durable action executor claims a typed containment command, calls the owning
backend API with an idempotency key, records the exact outcome, and then marks
the action complete. Unknown outcomes are quarantined, not automatically
replayed.

### Manual actions

- KYC require/clear calls the backend KYC API.
- Fiat deposit access calls the backend-owned GET/PUT API.
- Fraud locks use the existing explicit application mutation boundary.
- Whop refunds use owner step-up, live provider retrieval, disabled SDK
  retries, durable leases, and unknown-outcome quarantine.

## 7. Notification and bot flow

### Current event families

- `antifraud_risk`
- `fiat_operations`
- `high_risk_supplemental`
- `email_blacklist`
- `withdrawal_hold`
- signed dashboard ingest

### Current durable path

1. A producer writes one of several producer-specific Antifraud outboxes.
2. The monitor builds an embed.
3. The monitor signs a request to `/api/antifraud/discord-events`.
4. The dashboard resolves enabled event/channel routes.
5. One ADMIN `discord_notification_jobs` row is inserted per eligible channel.
6. The bot syncs its channel inventory.
7. The bot claims up to 25 jobs with a 60-second lease.
8. The bot sends the Discord message.
9. The bot acknowledges delivered or failed.
10. Failure uses exponential retry and eventually becomes `dead`.

### Bot-owned HTTP contract

All bot routes require an API key with `discord:antifraud` scope and the
configured Admin guild.

| Route | Contract |
|---|---|
| `POST /api/v1/discord/antifraud/channels/sync` | Guild identity, channel inventory, permissions, sync time |
| `POST /api/v1/discord/antifraud/jobs/claim` | Guild, worker ID, limit; returns leased embeds |
| `POST /api/v1/discord/antifraud/jobs/{id}/ack` | Lease token plus delivered/failed outcome |

The bot implementation itself is outside this repository. The recode can keep
this contract stable while replacing every upstream producer.

### Staff-dashboard notification boundary

Fraud automation must not write dashboard-bell notifications. The shared staff
bell is manual announcements only, created from
`/system/staff-notifications`. Player notification campaigns under
`/notifications` are a separate product.

## 8. Durable data inventory

### Antifraud DB

- Source and worker state: `source_cursors`, `monitor_activity_cursors`,
  `signup_ingestion_failures`, `network_scan_jobs`.
- Identity/evidence: `subjects`, `provider_checks`, `signup_assessments`,
  permanent profiles, assessment history, provider evidence, relationships,
  funding provenance, and immutable signup snapshots.
- Detection cases: `cases`, `monitor_sessions`, `risk_events`,
  `rule_definitions`, `rule_matches`, `staff_actions`.
- Configuration: `score_weights`, `analysis_rules`, `risky_locations`,
  `risky_location_audit`, `fiat_email_domain_blacklist` and audit,
  `identifier_blocklists`, `identifier_blocklist_matches`, and append-only
  identifier audit.
- Networks: `network_snapshots`, `network_nodes`, `network_node_secrets`,
  `network_edges`, `network_case_members`, `creator_fraud_assessments`.
- Withdrawals: `withdrawal_assessments`, `withdrawal_review_events`.
- Fiat: `fiat_deposit_assessments`, `fiat_deposit_review_events`,
  `fiat_eligibility_assessments`, email-domain matches.
- Free battles: `free_battle_risk_matches`, creator cursors.
- Current delivery: ingest cursor/receipts plus signup, rule, Fiat, hold, and
  free-battle outbox tables.
- Audit: `service_audit_events`.

### ADMIN DB

- Staff review: `antifraud_reviews`, `antifraud_review_notes`,
  `antifraud_signals`.
- Discord: `discord_notification_guilds`,
  `discord_notification_channels`, `discord_notification_events`,
  `discord_notification_routes`, `discord_notification_jobs`.
- Refund operation: `admin_whop_refund_batches`,
  `admin_whop_refund_items`.
- Shared audit, staff identity, permissions, and settings tables.

### MAIN mirror

Read-only fraud inputs include users, fingerprints, audit/register activity,
ledger transactions, balances, feature locks, Fiat intents/webhooks, KYC
state, affiliate relationships, tips, battles, battle participants, game
sessions, vouchers, withdrawals, rain, and reward activity.

## 9. Problems the recode must remove

1. `monitor.ts`, `fiat-risk.ts`, `withdrawal-risk.ts`, `network-risk.ts`, and
   `server.ts` are composition, policy, persistence, and transport mixed into
   very large modules.
2. There are multiple producer-specific outboxes with different retry,
   delivery, and acknowledgement semantics.
3. Antifraud cases and ADMIN reviews duplicate lifecycle state without one
   explicit projection contract.
4. Dashboard ingest both records facts and performs containment side effects.
5. HMAC parsing and verification is duplicated across dashboard endpoints.
6. Service authorization is partly a global path exception instead of a
   declared per-route capability.
7. Event vocabulary, score vocabulary, analysis rules, and notification event
   keys are separate registries that can drift.
8. Detection policy and enforcement policy are coupled in several flows.
9. Live Redis messages and durable events do not share one canonical envelope.
10. Signup dead letters affect health but have no supported staff inspection,
    retry, or dismissal workflow.
11. Direct and routed Discord concepts still coexist in module names and
    delivery code.
12. Cross-service action outcomes are not represented by one common
    succeeded/failed/unknown state machine.

## 10. Target architecture

### Canonical contracts

Introduce one versioned domain envelope:

```ts
type FraudEvent = {
  id: string;
  version: 1;
  kind: FraudEventKind;
  subject: { userId?: string; entityId?: string };
  source: { system: string; ref: string };
  occurredAt: string;
  observedAt: string;
  evidence: Record<string, unknown>;
  risk?: {
    score: number;
    severity: "low" | "medium" | "high" | "critical";
    signals: FraudSignal[];
  };
  correlationId: string;
};
```

Every detector returns evidence and signals. It does not open cases, lock
accounts, call Discord, or update staff workflow directly.

### Policy pipeline

```text
source reader
  -> detector
  -> canonical event store
  -> assessment reducer
  -> case policy
  -> action policy
  -> durable delivery/action outbox
  -> projectors and executors
```

### Store ownership

- Antifraud DB is authoritative for events, evidence, assessments, detection
  cases, action intents, and delivery state.
- ADMIN DB is a replaceable staff-workflow projection and Discord transport
  queue.
- MAIN remains a read source. Mutations go through backend-owned commands.
- Redis publishes committed canonical events only.

### One delivery model

Replace producer outboxes with one table keyed by:

- canonical event ID
- destination (`dashboard_projection`, `discord_router`, future destinations)
- delivery state
- attempt count and next attempt
- lease owner/token/expiry
- receipt body and last safe error

The dashboard returns per-event receipts. Partial batches cannot acknowledge
events that were not fully projected.

### One action model

Use typed action intents such as:

- `require_kyc`
- `lock_withdrawals`
- `set_fiat_access`
- `ban_account`
- `refund_payment`

Each action has a deterministic idempotency key and the states:

- `pending`
- `leased`
- `succeeded`
- `failed`
- `unknown`
- `cancelled`

Provider/backend calls happen outside database transactions. The result is then
recorded transactionally. `unknown` requires operator reconciliation.

### Case projection

The Antifraud case owns detection state. The ADMIN review owns staff workflow.
A versioned projector maps case events into one live review per user and stores
the Antifraud case ID as the stable source reference. Staff decisions emit a
command/event back to the Antifraud service; they are not silently mirrored by
ad-hoc writes.

## 11. Recode sequence

### Wave 0: freeze behavior

- Add contract tests for every HTTP route and every current event kind.
- Snapshot score definitions, thresholds, containment gates, and Discord event
  keys.
- Add a supported dead-letter operator view before changing ingestion.
- Do not change production decisions in this wave.

### Wave 1: shared contracts and composition

- Add `domain/`, `application/`, `infrastructure/`, and `transport/` boundaries.
- Move route registration out of `server.ts`.
- Introduce the canonical event and signal registry.
- Reuse one signed-request verifier and one service-capability guard.

### Wave 2: unified delivery

- Add the generic delivery table without deleting old outboxes.
- Dual-write and shadow-deliver with sends disabled on the new path.
- Reconcile counts and receipts by event ID.
- Cut dashboard projection first, then Discord routing.
- Retire old outboxes only after zero-drift verification.

### Wave 3: detector modules

Move one domain at a time behind stable interfaces:

1. signup and provider enrichment
2. live behavior and custom flows
3. email/deposit clusters
4. free/sponsored battles
5. Fiat assessment and eligibility
6. withdrawals and funding provenance
7. networks and creator cohorts

Each cutover uses recorded inputs and compares old/new signals, scores, and
decisions before enabling the new result.

### Wave 4: case and staff workflow

- Make the Antifraud case-to-ADMIN-review projection explicit.
- Replace decision mirroring with an idempotent command/result contract.
- Preserve the queue-visible review dialog and all current staff actions.

### Wave 5: action executor

- Move containment out of dashboard ingest.
- Route KYC, lock, Fiat access, ban, and refund commands through typed
  executors.
- Keep provider/backend-specific retry safety.
- The external game backend needs an idempotent containment endpoint if the
  existing mutation boundary cannot provide it.

### Wave 6: cleanup

- Remove old outbox tables and compatibility code through reviewed migrations.
- Remove legacy direct Discord concepts.
- Split the remaining large modules by domain and layer.
- Update runbooks, health, alerting, and recovery procedures.

## 12. Release gates

Every wave must prove:

- no MAIN mirror writes
- no loss or duplication of canonical events
- equal old/new score and decision output for the recorded corpus, unless an
  intentional policy change is separately approved
- replay-safe dashboard projection
- replay-safe bot jobs and acknowledgements
- working dead-letter recovery
- explicit unknown outcomes for unsafe external mutations
- monitor tests, repository guardrails, TypeScript, lint, and build pass where
  the changed boundary requires it

Production cutovers must be reversible by switching consumers back to the old
path while leaving canonical events and receipts intact.
