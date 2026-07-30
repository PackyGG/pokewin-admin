---
name: antifraud-monitor-deploy
description: "antifraud-monitor deploys via `railway up` from the REPO ROOT (not git-push, not the service dir) — Railway project admin-dashboard 602dd66e, service antifraud-monitor"
metadata: 
  node_type: memory
  type: project
  originSessionId: b1393151-cbfd-4ead-bae4-a1fa6dd5ca5d
  modified: 2026-07-30T07:46:30.248Z
---

The antifraud-monitor service does NOT auto-deploy on pushes to origin/main. It deploys via CLI upload: Railway workspace PackyGG → project `admin-dashboard` (id 602dd66e-df3a-4301-864a-15443a852261) → environment `production` → service `antifraud-monitor` (id 213a6f20-d961-453e-9e2e-515cdb153600). Sibling services in the same project: Redis, Antifraud (Postgres), Admin Dashboard, bots.

**How to deploy:** from a CLEAN checkout of origin/main, `railway link --project 602dd66e-… --environment production --service antifraud-monitor` then `railway up --detach` from the **repo root**. The service's root directory is pinned to `/services/antifraud-monitor`, so uploading from inside the service dir fails instantly with "Deployment does not have an associated build" (status FAILED, no build). Healthcheck `/health` (30s window) gates cutover; migrations auto-run at boot. Verify after: `https://antifraud-monitor-production.up.railway.app/health` + `/ready` (public, trimmed payloads since 2026-07-30).

**Why:** deployment metas carry no commit hash (uploads, not GitHub triggers); a push-only "deploy" silently changes nothing. Verified 2026-07-30 (deploy 905f7162). Railway CLI auth: `railway whoami` — the MCP bridge can be stale while the CLI session is valid. Related: [[concurrent-codex-sessions]].
