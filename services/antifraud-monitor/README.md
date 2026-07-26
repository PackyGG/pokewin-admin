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
- Authenticated HTTP API and single-use-ticket WebSocket stream
- `GET /v1/top-rain` for the top rain winners

Copy `.env.example` to `.env`, supply secrets and run `npm run dev`.

Database TLS is explicit per connection. Railway private-network databases use
`disable`; set the matching `*_DATABASE_SSL=require` variable when an external
source or mirror requires TLS.
