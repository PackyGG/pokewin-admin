# Packy Antifraud Monitor

`SOURCE_DATABASE_URL` must point to `MIRROR_PRODUCTION_DB`, never the primary
`DATABASE_URL`. Source reads remain read-only; mirror indexes are managed by
the repository root `db:index:mirrors` command.

Independent TypeScript service for signup risk assessment and short-lived
behaviour monitoring. It reads Packy through a read-only PostgreSQL connection
and stores all antifraud state in the dedicated Antifraud PostgreSQL database.

It does not modify the Packy frontend or backend.

## Runtime

- Incremental signup scan from the Packy source database
- Fingerprint Pro Plus event-integrity, IP/ASN/datacenter, VPN/proxy/Tor,
  blocklist, browser/device, velocity, mobile-integrity, and privacy-preserving
  proximity evidence from the stored signup request ID
- proxycheck.io stable v3 enrichment with confidence-aware proxy/VPN/Tor
  scoring, live risk, attack and prior-detection history, network/location,
  device-estimate and operator evidence, plus a 24-hour per-IP signup cache
- Score-based 10- and 15-minute monitor sessions
- Durable risk events, cases, rule matches and staff decisions
- Signed, retry-safe delivery of committed risk events to the Admin dashboard
- Durable Discord delivery for every score-50 signup, retried independently
  from the signed Account Review event stream
- Incremental detection of automatic lifetime-fiat withdrawal holds, with
  independent durable delivery to Account Review and a dedicated Discord
  webhook
- Durable Discord alerts for canonical high-risk fiat assessments and fiat
  intents created while the account's fiat deposits are locked, plus failed,
  review, disputed, refunded, stalled, and long-pending deposits and failed
  payment-webhook processing. Source detection reads only the MAIN mirror and
  delivery retries from the Antifraud database.
- Rate-limited HTTP API with separate read and admin-write credentials
- Fully automatic, environment-isolated Fiat checkout eligibility decisions
  with dedicated credentials and source-IP allowlists
- `GET /v1/scoring` for the canonical live risk-point configuration
- `GET /v1/operations/config` for sanitized deployed integration status
- Exact-origin WebSocket stream with 30-second, single-use subprotocol tickets
- `GET /v1/live/replay` for bounded catch-up after a dropped live connection
- `GET /v1/top-rain` for the top rain winners

Copy `.env.example` to `.env`, supply secrets and run `npm run dev`.

Discord alerts are submitted to the Admin dashboard's signed
`/api/antifraud/discord-events` endpoint and delivered by the shared Discord
bot. `ADMIN_GUILD_ID` fixes the destination server. Channel selection and
event-to-channel routing are configured in the dashboard; the monitor no
longer holds Discord webhook URLs. Its existing Antifraud outboxes retain
per-destination dedupe, retry, and partial-failure isolation.
`FIAT_ALERT_DASHBOARD_URL` controls the alert button target and defaults to the
live Antifraud Fiat Deposits workspace. Ordinary customer-canceled checkouts
are not alerted.

`ANTIFRAUD_INGEST_URL` and `ANTIFRAUD_INGEST_SECRET` configure the durable
Admin-dashboard sink. Committed `risk_events` are delivered in signed batches;
the delivery cursor advances only after the dashboard confirms every event.
Retries are idempotent because the risk-event id is the dashboard external id.
Score-50 signup markers use this same stream to open Account Review cases.
Neither value is returned by runtime status.

Automatic lifetime-fiat withdrawal holds and future non-email account
containment alerts use their own configurable event key. They retain the
compiled standard support mentions, link directly to Account Review, and retry
from the Antifraud database outbox until the dashboard accepts the event.

Database TLS is explicit per connection. Railway private-network databases use
`disable`; set the matching `*_DATABASE_SSL=require` variable when an external
source or mirror requires TLS. The Antifraud database connection always verifies
TLS certificates. The MAIN source uses encrypted libpq `require` semantics when
no CA is supplied; set `SOURCE_DATABASE_CA` to the private CA PEM to enable
strict source-certificate verification.

`API_TOKEN` is for reads and WebSocket ticket issuance. `API_ADMIN_TOKEN` is a
different credential used only for rule edits and case decisions. Never expose
either token to a browser. Mutation requests require a unique
`idempotencyKey`; writes and their immutable audit rows commit transactionally.
Rule edits and case decisions accept optional `actorId` and `actorUsername`
fields so the initiating staff identity is persisted instead of attributing a
human action to the service fallback. Reusing a key succeeds only when the
case/rule, action or patch, actor and reason exactly match the original
request; a changed request returns `409 idempotency_conflict`.

## Sanitized Sumsub review reads

Configure `SUMSUB_ADMIN_TOKEN` and `SUMSUB_ADMIN_KEY` together. The protected
`GET /v1/kyc/applicants/:applicantId/review` route signs read-only Sumsub API
requests and requires the monitor admin token. It returns only country,
nationality, document type/issuing-country, verification outcome, rejection
labels, and bounded review history. Names, dates of birth, addresses, document
numbers, document images, and private provider comments are never returned.
Successful reads are cached in memory for five minutes.

KYC Home also sends up to 100 recent completed applicants to
`POST /v1/kyc/country-checks/refresh`. The admin-only route compares the
account country with normalized, approved Sumsub document countries and stores
only the sanitized verdict in `kyc_country_reviews`. Each request reuses
six-hour saved results and refreshes at most ten providers with five concurrent
workers. Saved evidence contains country codes, provider status/answer,
applicant ID, and timestamps; it does not contain identity fields, document
numbers, images, or raw provider data.

## Automatic Fiat checkout eligibility

`POST /v1/fiat-eligibility/check` is a server-to-server endpoint. It never
accepts `API_TOKEN` or `API_ADMIN_TOKEN`. Development and production use
different credentials, source-IP allowlists and read-only source databases.
The credential selects the trusted environment; a body claiming the other
environment is rejected.

```json
{
  "env": "prod",
  "createdAt": "2026-07-29T12:00:00.000Z",
  "ipAddress": "203.0.113.20",
  "fingerprint": "fresh-fingerprint-request-id",
  "userID": "packy-user-id"
}
```

`fingerprint` is a fresh Fingerprint event `requestId`, not a visitor ID. The
event must be no more than two minutes old, must be linked to `userID`, and its
authoritative IP must match `ipAddress`. Every valid assessment performs the
full Fingerprint Pro Plus event lookup, an independent proxycheck.io lookup, and
a corroborating Abstract IP-intelligence lookup. Fingerprint and proxycheck are
mandatory and fail closed; Abstract only adds points when it degrades. It
compares the checkout with signup IP/device, account age,
account and Fiat locks, KYC, country policy, every fraud-enforcement list
(operator IP/fingerprint/email-domain, disposable email, and Admin excluded
users), shared networks, signup/case history, deposit, play and reward
behaviour, previous Fiat history and recent eligibility velocity.

### Hard containment rules

A denial normally touches nothing. These rules additionally CONTAIN the account
— Fiat deposits off, withdrawals locked — and cannot be out-scored:

- the checkout IP differs from signup and the account is younger than 7 days;
- the checkout device differs from signup and the account is younger than 36
  hours;
- the checkout IP *and* device both differ from signup and either carries a bad
  provider reputation, at any account age;
- a Fiat deposit for the account was paid less than 60 seconds ago;
- the checkout IP or device matches an active operator blocklist rule;
- the stored account email matches an active operator Fiat domain rule;
- Fingerprint reports the event as replayed, linked to a different account, or
  driven by a bad bot.

Containment is queued as a durable `fiat_eligibility_containment` risk event and
applied by the dashboard's signed ingest route under an advisory lock, so the
endpoint answers in provider latency and the lock retries until it lands. The
dashboard independently re-validates the reason codes, the `prod` environment
and the risk floor before it writes. It never bans, never sets `is_locked`,
never kills sessions and never touches KYC — staff resolve the review it opens.
`env=dev` assessments never contain anything: dev reads a different source
database, so a dev-driven lock would hit the wrong account population.
`FIAT_ELIGIBILITY_CONTAINMENT_ENABLED=false` keeps assessing and denying while
withholding the locks (`enforcement='suppressed'` on the stored row).

Account state that is already correct — banned, locked, self-excluded, Fiat or
country locked, KYC not cleared — denies without containment, as do provider
outages and stale requests. Disposable account email and Admin excluded-user
matches also deny without containment. The actual payer email remains unknown
before checkout and is checked again after authorization.

### Behaviour trust

Older, self-funded, actually-playing accounts buy headroom in the scored band:
account age tiers, completed crypto volume (the strongest good-faith evidence
we hold), completed Fiat history and real paid play all credit points, capped at
30 combined and dropped entirely once anything blocking fires. Reward-farmed
accounts pay instead — rain/promo/claim value with no completed deposit,
withdrawals with no deposit, or funding that never played. The lookback is
bounded to 365 days and rides the mirror's covering ledger index.

Successful assessments return only the persisted decision ID, the binary
result, and the immutable decision timestamp:

```json
{
  "decisionId": "assessment-uuid",
  "allowed": true,
  "timestamp": "2026-07-29T12:00:00.000Z"
}
```

Allow decisions expire 60 seconds after `timestamp`. The production backend
must bind the decision to that checkout attempt and must fail closed on `deny`,
an expired decision, any non-200 response, timeout or transport error.
Repeating the exact payload with the same Fingerprint request ID returns the
stored result; reusing that event with changed input returns
`409 fingerprint_reused`.

`migrations/source-mirror-indexes.sql` gained the per-user paid-intent and
withdrawal indexes this path needs; apply them with
`npm run db:index:mirrors -- all` from the repository root.

Configure `FIAT_ELIGIBILITY_PROD_API_KEY` with
`FIAT_ELIGIBILITY_PROD_ALLOWED_IPS`. Development additionally requires
`FIAT_ELIGIBILITY_DEV_API_KEY`, `FIAT_ELIGIBILITY_DEV_ALLOWED_IPS`, and
`FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL`. Allowlist entries are exact IPv4 or
IPv6 addresses or CIDRs. The allowlist applies to the calling backend's trusted
source IP; `ipAddress` in the JSON body is the end user's IP and is never used
to authenticate the caller. `ADMIN_DATABASE_URL` is a required read-only Admin
DB connection used for the excluded-users checkout list. Configure its TLS with
`ADMIN_DATABASE_SSL` and optional `ADMIN_DATABASE_CA`.

Every request writes structured `fiat_eligibility.*` lifecycle logs with the
Fastify request ID. Logs cover validation and authentication rejection, rate
limiting, assessment start, automatic allow/deny completion, Fingerprint replay
rejection, and assessment failure. Completion logs include the environment,
user ID, decision ID, score, reason codes, expiry, idempotency and duration.
The dedicated lifecycle records never include API keys, authorization headers,
Fingerprint request IDs, raw caller/client IPs, request bodies or
provider/database error messages. Fastify's separate transport request record
retains the platform-observed network peer address.

Signup assessment, case/session creation, initial risk events and cursor
advancement commit atomically. Provider successes are cached before that
transaction so a process restart does not normally repeat paid enrichment.
An unprocessable signup is retained in `signup_ingestion_failures` and its
cursor is advanced transactionally, preventing one poison account from
blocking or repeatedly enriching every later signup. The elected poller retries
stored failures in bounded batches with a capped attempt count, reports the
pending/recovered totals through its health snapshot, and removes a dead letter
only after the assessment and any case/session commit successfully.

Activity reads use a separate bounded batch per active session. The overlap
window preserves the full `(occurred_at, source, source_ref)` cursor, fresh
events are selected before overlap replays, and each session batch persists
its events, score and cursor in one transaction. Session windows are anchored
to the source signup timestamp and activity reads are capped at the exact
window end, including when an expired dead letter is reconstructed.

`GET /v1/operations/config` is protected by either service token and is the
source of truth for deployed monitor configuration. Its response is:

```json
{
  "data": {
    "discord": {
      "webhookConfigured": true,
      "dashboardUrlConfigured": true,
      "supportRecipientIds": ["..."],
      "urgentRecipientIds": ["..."]
    },
    "providers": {
      "fingerprintConfigured": true,
      "proxycheckConfigured": true
    },
    "live": {
      "redisConfigured": true,
      "readTokenConfigured": true,
      "adminTokenConfigured": true,
      "exactOriginsConfigured": true
    }
  }
}
```

Only presence booleans and the recipient ids compiled into the deployed
service are returned. The dashboard URL, webhook URL, database URLs, Redis URL,
tokens and provider keys are never included.

## Live stream and replay

Every live frame carries a top-level string `id` — the Redis Stream entry id of
the event (`<ms>-<seq>`, monotonic). Events are appended to
`antifraud:live:stream` (capped at ~2000 entries) before they are published to
the `antifraud:live` pub/sub channel, so a client that drops its connection can
catch up with `GET /v1/live/replay?after=<last id>&limit=<1..200>`. That route
takes the read bearer token, returns `{ data: LiveFrame[], cursor }` in
ascending id order and excludes `after` itself. Omit `after` to receive the most
recent frames. The `connected` frame sent on WebSocket accept carries `id: ""`
because it is not a stream event.

A rejected WebSocket handshake closes with a machine-readable reason —
`origin_not_allowed`, `invalid_ticket` or `too_many_connections` — and the
origin rejection is logged server-side with the configured allowlist.

## Timezone and health

Set `TZ=UTC` as a service variable (Railway variables are not settable from
`railway.json`); the process also defaults `TZ` to `UTC` at boot and both
connection pools pin `-c TimeZone=UTC`, so naive timestamps never depend on the
container's local zone.

`/health` returns `503` when the elected poller leader has not completed a
successful tick within `POLLER_LIVENESS_TIMEOUT_MS` (default 120000), so the
platform restarts a wedged engine. Standby replicas always report healthy.
`/ready` additionally requires both databases and a live Redis channel
subscription. A failed initial subscribe fails the boot on purpose.

`ALLOWED_ORIGINS` is an exact browser-origin allowlist. Production currently
contains only `https://fraud.packydash.com`. Browser requests from any other
origin or with `Sec-Fetch-Site: cross-site` receive `403`; server-to-server
dashboard calls still require a bearer token and may omit browser-only headers.

`migrations/source-mirror-indexes.sql` is for the read mirror only. Its guarded
IPv6 expression tolerates malformed `signup_ip` text, and its rain-win index
starts with `created_at` so the 365-day leaderboard bound is indexable. Do not
apply that file to the Packy primary database.
