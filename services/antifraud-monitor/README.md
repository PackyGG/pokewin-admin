# Packy Antifraud Monitor

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
- Rate-limited HTTP API with separate read and admin-write credentials
- `GET /v1/scoring` for the canonical live risk-point configuration
- Exact-origin WebSocket stream with 30-second, single-use subprotocol tickets
- `GET /v1/top-rain` for the top rain winners

Copy `.env.example` to `.env`, supply secrets and run `npm run dev`.

Database TLS is explicit per connection. Railway private-network databases use
`disable`; set the matching `*_DATABASE_SSL=require` variable when an external
source or mirror requires TLS. TLS verification is strict; provide the matching
`*_DATABASE_CA` only when the server certificate needs a private CA.

`API_TOKEN` is for reads and WebSocket ticket issuance. `API_ADMIN_TOKEN` is a
different credential used only for rule edits and case decisions. Never expose
either token to a browser. Mutation requests require a unique
`idempotencyKey`; writes and their immutable audit rows commit transactionally.
