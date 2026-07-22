# Admin API — bot integration guide

Machine-to-machine API for the rewards Discord bot and in-house scripts.

- **Base URL:** the admin dashboard's origin (e.g. `https://pokewin-admin.vercel.app`)
- **Auth:** `Authorization: Bearer <token>` on every request
- **Content type:** `application/json`
- **Manage keys:** admin dashboard → **System → Admin API**

---

## 1. Get a key

In the dashboard: **System → Admin API → New key**.

Pick the narrowest scopes that work. For the link check you only need
**`discord:read`**.

> The token is shown **once** and stored hashed — we cannot recover it. Save it
> straight into the bot's secret manager. If it leaks, revoke it in the same UI;
> revocation takes effect on the very next request.

---

## 2. Smoke test — `GET /api/v1/whoami`

Confirms the token works and shows what it is allowed to do. Needs a valid key
but no particular scope.

```bash
curl -s https://pokewin-admin.vercel.app/api/v1/whoami \
  -H "Authorization: Bearer $PACKY_API_KEY"
```

```json
{
  "data": {
    "keyId": "2b7c...",
    "name": "Rewards bot",
    "prefix": "pwa_xR3k9…",
    "scopes": ["discord:read"]
  }
}
```

If this returns `401`, the token is wrong/revoked. Fix that before anything else.

---

## 3. Is a Discord user linked? — `POST /api/v1/discord/linked`

**Scope required:** `discord:read`

### Request

```http
POST /api/v1/discord/linked
Authorization: Bearer <token>
Content-Type: application/json

{ "discordUserId": "123456789012345678" }
```

### Response `200`

```json
{ "data": { "discordUserId": "123456789012345678", "linked": true } }
```

`linked` is `true` when that Discord account is connected to a Packy account
(linked or signed up with Discord), `false` otherwise.

> It is a **boolean only** — deliberately no user id, username, email or
> balance. The bot can confirm a link for an ID it already knows, but the
> endpoint can never be used to enumerate or profile players. If you need more
> fields later, ask and we'll add a separate, explicitly-scoped endpoint.

### Why POST and not GET

The Discord ID is personal data. In a GET it would sit in the URL and end up in
access logs, proxy logs and error trackers. A POST body keeps it out of all of them.

---

## 4. Examples

### Node (discord.js)

```js
async function isLinked(discordUserId) {
  const res = await fetch(`${process.env.PACKY_API_URL}/api/v1/discord/linked`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PACKY_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ discordUserId }),
  });

  if (!res.ok) {
    const { error } = await res.json().catch(() => ({}));
    throw new Error(`packy api ${res.status}: ${error?.code ?? "unknown"}`);
  }

  const { data } = await res.json();
  return data.linked;
}
```

### Python

```python
import os, requests

def is_linked(discord_user_id: str) -> bool:
    r = requests.post(
        f"{os.environ['PACKY_API_URL']}/api/v1/discord/linked",
        headers={"Authorization": f"Bearer {os.environ['PACKY_API_KEY']}"},
        json={"discordUserId": discord_user_id},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()["data"]["linked"]
```

### curl

```bash
curl -s -X POST https://pokewin-admin.vercel.app/api/v1/discord/linked \
  -H "Authorization: Bearer $PACKY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"discordUserId":"123456789012345678"}'
```

---

## 5. Responses & errors

Success is always wrapped in `data`; failures always in `error`.

```json
{ "error": { "code": "invalid_api_key", "message": "Invalid or missing API key." } }
```

| Status | `code` | Meaning | What to do |
|---|---|---|---|
| 200 | — | OK | — |
| 400 | `invalid_json` | Body wasn't valid JSON | Fix the request |
| 400 | `invalid_request` | `discordUserId` missing or not a numeric Discord ID | Fix the request |
| 401 | `invalid_api_key` | Missing, malformed, unknown, revoked or expired key | Check/rotate the token |
| 403 | `insufficient_scope` | Key lacks `discord:read` | Re-issue with the scope |
| 429 | `rate_limited` | Over the key's per-minute budget | Back off — honour `Retry-After` |
| 500 | `internal_error` | Something broke on our side | Retry with backoff; report if persistent |

`401` is intentionally identical for every credential problem (unknown key,
wrong secret, revoked, expired) — it can't be used to probe which keys exist.

---

## 6. Rate limits

Each key has a per-minute budget (default **120 req/min**, set when the key is
created). Every response carries:

```
RateLimit-Limit: 120
RateLimit-Remaining: 118
RateLimit-Reset: 47
```

On `429` a `Retry-After` header (seconds) is included — wait that long. Please
back off rather than retrying in a tight loop.

---

## 7. Operational notes

- **HTTPS only.** Never send the token over plain HTTP.
- **Never commit the token** or paste it into Discord — treat it like a password.
- **Rotate** by creating a new key, deploying it, then revoking the old one.
- Every auth failure is logged to the admin audit trail (prefix + IP + path —
  never the token), so repeated failures are visible to us.
- Responses are `no-store`; do not cache them in a shared cache.
