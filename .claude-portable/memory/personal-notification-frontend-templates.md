---
name: personal-notification-frontend-templates
description: "Personal notifications render from a small hardcoded frontend map; an unknown `type` silently falls back and drops the payload"
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e58921f-e659-4642-9018-896460ff734e
  modified: 2026-07-22T22:22:51.174Z
---

Per-user notifications (`POST /v1/admin/notifications[/bulk]`) deliver `payload`
fine, but what the user SEES comes from the frontend repo, not the backend:

- `frontend/src/components/navigation/notification-text.ts` maps `type` →
  `{title, body, code?}`. Cases as of 2026-07-23: `deposit_pending`,
  `deposit_completed`, `reward_credited`, `promo_code_granted`. Its `default:`
  returns `{ title: "Notification", body: type.replace(/_/g," ") }` — an
  unknown type renders as its own name with the payload dropped.
- `promo_code_granted` shipped in PackyGG/frontend#749 (merged to `dev`
  2026-07-22): the optional `code` field renders as a monospace chip, clicking
  the row copies it, and the realtime websocket toast carries its own Copy
  action.
- `frontend/src/components/navigation/notification-popover.tsx` builds personal
  rows with **no `href`** — only broadcast announcement rows read
  `payload.url`. Adding a link to a personal payload still does nothing.
- **Two consumers, not one:** the popover AND
  `frontend/src/lib/websocket/notifications.ts` (the live toast) both call
  `notificationText()`. Copy that only makes sense in one surface (e.g. "tap to
  copy") is a bug in the other. Always check both.

**Why:** the admin can send a technically-perfect notification that looks broken
to the user, and it isn't a backend or admin bug.

**How to apply:** a new personal-notification `type` needs a matching case in
`notification-text.ts` before it's worth sending for real. The admin mirrors
this list in `src/lib/user-notification-templates.ts` and warns on unknown
types (and on a promo payload missing `code`) — keep the two in sync. Promo
codes are redeemed in the wallet's deposit tab, which has no deep link, which
is why copy-to-clipboard is the interaction. See [[repo-scope-boundary]].
