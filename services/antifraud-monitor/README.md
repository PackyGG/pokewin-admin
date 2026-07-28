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
- Fingerprint Pro Plus Smart Signals from the stored signup request ID
- proxycheck.io IP enrichment with a 24-hour per-IP cache
- Configurable three-minute monitor sessions
- Durable risk events, cases, rule matches and staff decisions
- Signed, retry-safe delivery of committed risk events to the Admin dashboard
- Durable Discord delivery for every score-60 signup, retried independently
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
- `GET /v1/scoring` for the canonical live risk-point configuration
- `GET /v1/operations/config` for sanitized deployed integration status
- Exact-origin WebSocket stream with 30-second, single-use subprotocol tickets
- `GET /v1/live/replay` for bounded catch-up after a dropped live connection
- `GET /v1/top-rain` for the top rain winners

Copy `.env.example` to `.env`, supply secrets and run `npm run dev`.

`FIAT_ALERT_DISCORD_WEBHOOK_URL` is the dedicated fiat-operations channel for
failed, review, dispute, refund, stalled checkout, stale pending, and failed
provider-webhook alerts. Canonical high-risk deposits and deposits from
fiat-locked accounts use the general `ANTIFRAUD_DISCORD_WEBHOOK_URL`.
Blacklisted signup or Whop checkout email-domain containment uses
`FIAT_EMAIL_BLACKLIST_DISCORD_WEBHOOK_URL`. Automatic withdrawal holds and
other account-containment alerts use
`ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL`.
`FIAT_ALERT_DASHBOARD_URL` controls the alert button target and defaults to the
Fiat Payments workspace. Ordinary customer-canceled checkouts are not alerted.

`ANTIFRAUD_INGEST_URL` and `ANTIFRAUD_INGEST_SECRET` configure the durable
Admin-dashboard sink. Committed `risk_events` are delivered in signed batches;
the delivery cursor advances only after the dashboard confirms every event.
Retries are idempotent because the risk-event id is the dashboard external id.
Score-60 signup markers use this same stream to open Account Review cases.
Neither value is returned by runtime status.

`ANTIFRAUD_WITHDRAWAL_HOLD_DISCORD_WEBHOOK_URL` is the dedicated containment
destination for automatic lifetime-fiat withdrawal holds and future non-email
account lock/ban alerts. Those alerts use the compiled standard support
mentions, link directly to Account Review, and retry from the Antifraud
database outbox until Discord accepts them. Webhook URLs are never returned by
runtime status.

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
