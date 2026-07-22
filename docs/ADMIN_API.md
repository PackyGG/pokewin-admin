# Admin API — Discord bot integration guide

Machine-to-machine API for the rewards Discord bot and in-house scripts.

- **Base URL:** the admin dashboard's origin (e.g. `https://pokewin-admin.vercel.app`)
- **Auth:** `Authorization: Bearer <token>` on every request
- **Content type:** `application/json`
- **Manage keys:** admin dashboard → **System → Admin API**

Everything is `POST` with a JSON body, even the read-only endpoints. That is
deliberate: a Discord user ID is personal data, and a GET would put it in the
URL where it lands in access logs, proxy logs and error trackers.

---

## 1. What the bot is for

Players link their Discord to their Packy account and use the bot to see and
claim **creator VIP wager rewards** — a per-creator deal of the shape *"wager
$1,000 under my code, get $5"*.

The bot **never** moves money. A claim it files is a **request**; staff approve
it by hand in the dashboard, and only then is the player's balance credited.
Design the UX around that: the honest message after a successful claim is
"submitted for review", never "paid".

### The four commands

| Command | Endpoint | What it does |
|---|---|---|
| `/verify` | `POST /api/v1/discord/verify` | Confirms the account is linked, and records that they verified |
| `/info` | `POST /api/v1/discord/info` | Their summary card: code, time left, totals |
| `/check` | `POST /api/v1/discord/rewards` | What they can claim right now |
| *(Claim button)* | `POST /api/v1/discord/claim` | Files a claim for staff review |

---

## 2. Rules you need to model correctly

These are the parts that are easy to get subtly wrong in bot copy.

### Wager only counts while attached to the code

A player's bets are recorded against whichever affiliate code was active at the
time. Wager placed while on someone else's code is invisible to this program —
it isn't lost, it just belongs to that other code.

### The code attribution lasts 7 days

Entering a code binds the player to it for **7 days**. During that window they
cannot switch to a different code. After it lapses, no code is active and their
wager stops counting toward anything until they re-enter one.

### Expiring is fine. Switching is not.

This distinction matters and the bot must not blur it:

| Event | What happened | Effect on rewards |
|---|---|---|
| **Expired** | The 7-day window lapsed. Same code, player did nothing. | **Nothing is lost.** Everything already earned stays claimable. New wager stops counting until they re-enter the code. |
| **Switched** | They deliberately moved to a *different* creator's code. | **They can no longer claim** rewards built up under the old one, and progress on it resets. |

`/info` returns `codeSecondsRemaining` and `codeExpired` so you can nudge
players to re-enter their code — but **never** tell an expired player they have
lost their rewards. They haven't.

### Partial progress doesn't pay

Only whole thresholds pay out. At $5 per $1,000, someone who has wagered $1,999
gets **$5**, and the remaining $999 stays banked toward their next one.

### VIP is checked live, every time

Some programs pay a higher rate to VIP-tagged players (e.g. $7.50 instead of
$5). The tag is re-read on **every** check and claim — a player who loses it
drops back to the standard rate immediately. Never cache a rate.

### Claiming consumes wager

An approved claim permanently uses up the wager it paid for. A pending claim
reserves it immediately, so a player cannot file twice against the same wager.

---

## 3. Get a key

In the dashboard: **System → Admin API → New key**. Pick the narrowest scopes
that work.

| Scope | Unlocks |
|---|---|
| `discord:verify` | `/discord/verify` |
| `discord:info:read` | `/discord/info` |
| `discord:rewards:read` | `/discord/rewards` |
| `discord:rewards:claim` | `/discord/claim` |
| `discord:read` | `/discord/linked` (only needed for a bare link check) |

A full rewards bot needs the first four.

> **`discord:info:read` is the sensitive one.** It is the only endpoint that
> returns a username and internal user id. Every other endpoint is built so a
> leaked token cannot enumerate or profile players. Grant it only to a bot that
> genuinely renders a player-facing card, and never bundle it into a key that
> just needs link checks.

There is also a **`*` full-access** option. It satisfies every scope check —
including endpoints added later — so it never needs re-issuing. That is both
the convenience and the risk: a standing grant to the whole surface. Use it for
a trusted first-party consumer or while prototyping; give the bot granular
scopes.

> The token is shown **once** and stored hashed — it cannot be recovered. Save
> it straight into the bot's secret manager. If it leaks, revoke it in the same
> UI; revocation takes effect on the very next request.

### Lock the key to your server's IP (recommended)

The create dialog has an **Allowed IPs** field. Leave it blank and the key works
from anywhere; fill it in and the key is rejected from every other address, so a
leaked token is useless off your box.

- Comma-separated, **exact addresses** — no CIDR ranges, list each one.
- Use your Railway **static egress IP**. If egress can rotate, list every
  possible address, or leave it blank rather than risk locking the bot out.
- Requests from a non-listed IP get `403 ip_not_allowed`, and the attempt is
  audited.

Defence in depth, not a replacement for the token — keep both.

---

## 4. `/verify` — `POST /api/v1/discord/verify`

**Scope:** `discord:verify`

Confirms the link **and records the verification**, so you can greet a
first-timer differently from someone re-running it.

```http
POST /api/v1/discord/verify
Authorization: Bearer <token>
Content-Type: application/json

{ "discordUserId": "123456789012345678" }
```

```json
{
  "data": {
    "discordUserId": "123456789012345678",
    "linked": true,
    "alreadyVerified": false,
    "firstVerifiedAt": "2026-05-03T18:22:41.000Z",
    "verifyCount": 1
  }
}
```

- `alreadyVerified: false` → first successful verify. Send the welcome message,
  post the channel notification, assign the role.
- `alreadyVerified: true` → they have done this before. Show a short
  "you're already verified, since 3 May" and **suppress the channel
  notification** — re-running the command must not re-announce them.
- Not linked → `404 not_linked`. Nothing is recorded, so an unlinked probe
  leaves no trace. Tell them to link on the site and try again.

---

## 5. `/info` — `POST /api/v1/discord/info`

**Scope:** `discord:info:read`

The player's summary card.

```json
{
  "data": {
    "discordUserId": "123456789012345678",
    "userId": "u_9f1c…",
    "username": "kartos",
    "code": "JIMMY",
    "codeExpiresAt": "2026-07-29T19:58:47.000Z",
    "codeSecondsRemaining": 384210,
    "codeExpired": false,
    "openRewardsUsd": 15,
    "pendingReviewUsd": 5,
    "totalClaimedUsd": 60
  }
}
```

| Field | Meaning |
|---|---|
| `code` | The code they're on now. `null` if none. |
| `codeSecondsRemaining` | Until the 7-day attribution lapses. `null` if unknown. |
| `codeExpired` | Window has passed. **Informational only** — see §2. |
| `openRewardsUsd` | Claimable right now, across all their programs. |
| `pendingReviewUsd` | Filed, waiting on staff. |
| `totalClaimedUsd` | Approved and paid, lifetime. |

Good copy for an expired code: *"Your code has expired — re-enter JIMMY on the
site to keep earning. Your $15 is safe."* Bad copy: *"You lost your rewards."*

---

## 6. `/check` — `POST /api/v1/discord/rewards`

**Scope:** `discord:rewards:read`

Everything the player can claim.

```json
{
  "data": {
    "discordUserId": "123456789012345678",
    "claimable": [
      { "id": "ur_9f1c…", "name": "Welcome Pack" },
      { "id": "rb_daily", "name": "Daily Rakeback", "amount": 5.5, "currency": "USD" },
      { "id": "vip_3b7c…", "name": "Jimmy VIP reward", "amount": 10, "currency": "USD", "claimable": true },
      { "id": "vip_8e2a…", "name": "Sarah VIP reward", "claimable": false,
        "progress": "$340.00 more wagered to unlock the next reward" }
    ]
  }
}
```

**Only `vip_*` entries can be claimed through the bot.** They carry
`claimable: true` when something is ready. Everything else — `ur_*` (unopened
rewards) and `rb_*` (rakeback) — is claimed on the site; show it as information
and link them there.

- `claimable: true` → render a **Claim** button.
- `claimable: false` → show `progress` verbatim. Do not offer a button.
- `id` and `name` are always present; `amount` only when there genuinely is a
  cash value (many rewards grant packs, not cash — don't render `$0`).
- **Nothing to claim → `200` with `"claimable": []`.** Never a 404. Only an
  explicit empty array means "you have nothing".
- **Unlinked → `404 not_linked`**, deliberately *not* an empty array, so you
  can never tell an unlinked player they have no rewards.

---

## 7. Claim — `POST /api/v1/discord/claim`

**Scope:** `discord:rewards:claim`

```http
{ "discordUserId": "123456789012345678", "claimableId": "vip_3b7c…" }
```

```json
{
  "data": {
    "claimId": "c_1a2b…",
    "amount": 10,
    "currency": "USD",
    "units": 2,
    "status": "pending_review",
    "message": "Your claim has been submitted and is awaiting staff review. You'll be credited once it's approved."
  }
}
```

Send **only** the Discord ID and the `claimableId` from `/check`. Never send an
amount — the server recomputes eligibility from scratch and pays what is
actually true at write time, so a stale number the player saw two minutes ago
cannot inflate anything.

**Nothing is paid here.** Say "submitted for review". They are credited when
staff approve, which may be hours later.

Claim-specific failures:

| Status | `code` | Meaning |
|---|---|---|
| 409 | `already_pending` | They already have a claim in the queue for this program. Say "we're already on it" — this is not an error. |
| 400 | `nothing_claimable` | Not enough wager yet. The message carries how much more is needed. |
| 400 | `not_eligible` | Blocked — switched code, banned, locked, program inactive. Message explains which. |
| 400 | `not_claimable_here` | A non-`vip_*` id. That reward is claimed on the site. |
| 404 | `program_not_found` | Program no longer exists. |

---

## 8. Link check only — `POST /api/v1/discord/linked`

**Scope:** `discord:read`

```json
{ "data": { "discordUserId": "123456789012345678", "linked": true } }
```

A boolean and nothing else — no user id, username, email or balance. Use
`/verify` for the actual `/verify` command; this exists for a bare check that
must not write anything.

---

## 9. Errors

Success is always wrapped in `data`, failures always in `error`.

```json
{ "error": { "code": "invalid_api_key", "message": "Invalid or missing API key." } }
```

| Status | `code` | What to do |
|---|---|---|
| 400 | `invalid_json` | Fix the request |
| 400 | `invalid_request` | Body malformed, or carries unexpected keys — bodies are strict |
| 401 | `invalid_api_key` | Missing, malformed, unknown, revoked or expired key |
| 403 | `insufficient_scope` | Re-issue the key with the scope |
| 403 | `ip_not_allowed` | Caller IP not on the key's allowlist |
| 404 | `not_linked` | Tell the user to link their Discord on the site |
| 409 | `already_pending` | Already in the review queue |
| 429 | `rate_limited` | Back off — honour `Retry-After` |
| 500 | `internal_error` | Retry with backoff; report if it persists |

`401` is intentionally identical for every credential problem, so it can't be
used to probe which keys exist.

**Never report "you have nothing" on an error.** Only an explicit empty
`claimable` array means that. On any failure, say you couldn't check.

---

## 10. Rate limits

Each key has a per-minute budget (default **120 req/min**, set at creation).
Every response carries:

```
RateLimit-Limit: 120
RateLimit-Remaining: 118
RateLimit-Reset: 47
```

On `429` a `Retry-After` header (seconds) is included. Back off rather than
retrying in a tight loop.

---

## 11. Example — Node / discord.js

```js
const API = process.env.PACKY_API_URL;
const KEY = process.env.PACKY_API_KEY;

async function call(path, body) {
  const res = await fetch(`${API}/api/v1/discord/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error?.message ?? `HTTP ${res.status}`);
    err.code = json?.error?.code ?? "unknown";
    err.status = res.status;
    throw err;
  }
  return json.data;
}

// /verify — announce only on the FIRST successful verify.
async function verify(discordUserId) {
  const data = await call("verify", { discordUserId });
  if (!data.alreadyVerified) {
    await postChannelNotification(discordUserId);
    return "Verified — welcome aboard!";
  }
  const since = new Date(data.firstVerifiedAt).toLocaleDateString();
  return `You're already verified (since ${since}).`;
}

// /check — only vip_* entries get a Claim button.
async function check(discordUserId) {
  const { claimable } = await call("rewards", { discordUserId });
  return {
    claimNow: claimable.filter((r) => r.claimable === true),
    progress: claimable.filter((r) => r.claimable === false),
    onSite: claimable.filter((r) => r.claimable === undefined),
  };
}

// Claim button — submitted, NOT paid.
async function claim(discordUserId, claimableId) {
  try {
    const data = await call("claim", { discordUserId, claimableId });
    return `Claim for $${data.amount} submitted — staff will review it shortly.`;
  } catch (e) {
    if (e.code === "already_pending") return "You've already got a claim in the queue.";
    if (e.code === "nothing_claimable") return e.message; // carries how much more is needed
    if (e.code === "not_eligible") return e.message;
    throw e;
  }
}
```

### curl

```bash
curl -s -X POST https://pokewin-admin.vercel.app/api/v1/discord/info \
  -H "Authorization: Bearer $PACKY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"discordUserId":"123456789012345678"}'
```

---

## 12. Operational notes

- **HTTPS only.** Never send the token over plain HTTP.
- **Never commit the token** or paste it into Discord — treat it as a password.
- **Rotate** by creating a new key, deploying it, then revoking the old one.
- Every auth failure is logged to the admin audit trail (key prefix + IP +
  path — never the token), so repeated failures are visible.
- Responses are `no-store`; do not put them in a shared cache.
- **Don't cache reward figures.** VIP status, code standing and wager all move
  independently; always re-read before showing or claiming.
