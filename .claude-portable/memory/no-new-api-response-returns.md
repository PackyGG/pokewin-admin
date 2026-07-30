---
name: no-new-api-response-returns
description: Owner rule — never add new data fields/returns to any backend API endpoint response; route internal data through internal storage + direct DB reads
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d4f148e1-2501-4456-97ae-4eb29709a862
---

Owner rule (verbatim): "never ever add any new returns to the api! like data returns from a ep". When building features that touch `PackyGG/backend`, do NOT add any new field or data to any endpoint's response payload — the API contract stays frozen.

**Why:** keeps the API contract stable for clients, and (critically) prevents internal/hidden data from leaking to users. Concrete case: the hidden crypto exchange-rate fee — surfacing `market_price`/`fee_bps`/`fee_usd` on a transaction endpoint would both break the rule and expose the hidden fee.

**How to apply:** put new internal-only data in an internal column that existing response schemas already strip — e.g. `ledger_transactions.metadata` (JSONB), which the Fastify `fast-json-stringify` response-schema allowlist drops because it's not in `DepositWithdrawalSchema` etc. Have the admin read it **directly from the game DB** (`dbForEnv`), never through a backend API. Before shipping any backend feature: verify NO response schema changed and no endpoint returns raw rows that would spill the new column. See [[feedback-repo-scope-boundary]] (backend is PR-only) and the crypto-fee-tracking work (backend PR #445).
