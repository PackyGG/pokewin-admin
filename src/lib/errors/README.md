# Error handling — pokewin-admin

How the admin panel handles, contains, and reports failures. Read this
before adding new pages, server actions, or live-polling widgets.

---

## The 4-layer boundary model

Errors are caught at the closest possible scope. Each layer below it is
strictly a fallback for what slipped through.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1 — Sub-tile defenses (safeQuery + TileErrorFallback)        │
│    One failed query degrades ONE tile. Page stays usable.            │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 2 — Suspense fallbacks (component-scoped)                     │
│    A slow segment streams behind a skeleton; a thrown segment        │
│    bubbles to the nearest error.tsx.                                  │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 3 — Segment error.tsx (per-route boundary)                    │
│    Page-level throw → friendly recoverable view with Try Again.       │
│    Files: src/app/(admin)/<segment>/error.tsx                         │
├─────────────────────────────────────────────────────────────────────┤
│  Layer 4 — Global error.tsx (app/global-error.tsx)                   │
│    Layout / root-tree crash. Last resort, always available.           │
└─────────────────────────────────────────────────────────────────────┘
```

Goal: 99% of failures contained at Layer 1, the rest at Layer 2 or 3.
Layer 4 should be empty in normal operation.

---

## Layer 1 — sub-tile resilience

### When a page composes multiple parallel queries

Anti-pattern (one bad query crashes everything):

```tsx
const [users, stats, vault] = await Promise.all([
  getUsers(),
  getStats(),
  getVaultUsd(),
]);
return <UsersList users={users} stats={stats} vault={vault} />;
```

Pattern — wrap each query in `safeQuery`:

```tsx
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

const [usersR, statsR, vaultR] = await Promise.all([
  safeQuery(() => getUsers(),    [],   "users.list"),
  safeQuery(() => getStats(),    null, "users.stats"),
  safeQuery(() => getVaultUsd(), null, "users.vault"),
]);

return (
  <>
    {usersR.error ? <TileErrorFallback label="Users" /> : <UsersList users={usersR.data} />}
    {statsR.error ? <TileErrorFallback label="Stats" /> : <Stats data={statsR.data} />}
    {vaultR.error ? <TileErrorFallback label="Vault" /> : <Vault data={vaultR.data} />}
  </>
);
```

Each tile owns its own failure. The page never crashes from a single
slow Postgres timeout.

### When the empty state is enough

If your tile already renders an empty/zero state, use the shorter
`safeQueryOrNull`:

```tsx
const { data } = await safeQueryOrNull(() => getOptionalThing(), "things.opt");
return <Tile data={data} />;  // tile internally handles null
```

---

## Layer 2 — Suspense per heavy segment

Slow-but-independent server components belong behind their own Suspense.
This is already standard on `/dashboard`, `/users`, `/creators` — match
the existing style.

```tsx
<Suspense fallback={<KpiStripSkeleton count={6} />}>
  <KpiStrip />          {/* async server component, runs its own queries */}
</Suspense>
```

When the async child uses `safeQuery` internally, a failing query
degrades the tile (Layer 1). When the async child itself throws
unexpectedly, the segment bubbles to the nearest `error.tsx`.

---

## Layer 3 — segment error.tsx

Every admin segment has its own `error.tsx`. The umbrella
`src/app/(admin)/error.tsx` covers anything without a more specific
boundary.

When adding a new admin route:
- Match the existing copy style (icon + title + hint + Try Again).
- Use `PageHero` so the visual matches the rest of the surface.
- Always log the caught error inside `useEffect` (the framework
  already logs server-side; client-side logging helps devtools).

Reference the existing files: `src/app/(admin)/dashboard/error.tsx`,
`src/app/(admin)/users/error.tsx`, `src/app/(admin)/users/[id]/error.tsx`.

---

## Layer 4 — global-error.tsx

Already in place at `src/app/global-error.tsx`. Never edit unless
genuinely changing the platform-wide last-resort UI.

---

## Server Action contract — ServerActionResult

Server actions return `ServerActionResult<T>` instead of throwing.
Full pattern + rationale: see `server-action-result.ts`.

### Server side

```ts
"use server";
import { ok, fail } from "@/lib/errors/server-action-result";
import { logError } from "@/lib/errors/logger";

export async function processWithdrawal(
  id: string,
): Promise<ServerActionResult<{ id: string }>> {
  const session = await requirePageAccess("/withdrawals");
  if (!hasCapability(session, "...")) {
    return fail("You don't have permission for that", "FORBIDDEN");
  }
  try {
    await db.withdrawal.update({ where: { id }, data: { status: "processing" } });
  } catch (err) {
    logError("withdrawals.process", `withdrawal ${id} failed`, err);
    return fail("Couldn't process this withdrawal — please retry");
  }
  revalidatePath("/withdrawals");
  return ok({ id });
}
```

### Client side

```tsx
"use client";

async function onSubmit() {
  setLoading(true);
  const result = await processWithdrawal(id);
  setLoading(false);
  if (!result.success) {
    toast.error(result.error);
    return;
  }
  toast.success("Processed");
  setOpen(false);
}
```

No more `err instanceof Error ? err.message : "fallback"` at every
call site. The shape is the same every time.

### Migration

Existing throw-style actions migrate as the team touches them. Don't
big-bang convert — pick the ones with the most-error-prone paths
first. `tryServerAction` (also in `server-action-result.ts`) wraps a
legacy thunk if you want to switch the public contract without
rewriting the action body.

---

## Logger — logError / logWarn / logInfo

Plain `console.error` with a consistent prefix. No third-party
dependency, no tracing service — Vercel function logs are the
source of truth.

```ts
import { logError, logWarn } from "@/lib/errors/logger";

logError("dashboard.kpi", "primary KPIs failed", err);
logWarn("auth.session", "expired session refused");
```

Format on the wire: `<iso-timestamp> [error:<area>] <message> — <error.name>: <error.message>`.

`area` is a dot-namespaced tag — `<feature>.<sub>`. Pick a name future
agents can grep for.

### Where to put `logError` calls

- Inside `safeQuery` (already done — automatic, no work for you).
- Inside `catch (err) { ... return fail(...) }` blocks in server actions.
- Inside `error.tsx` boundaries (`useEffect` on client side mirrors the
  log to devtools; the server already logged the throw).
- Inside the catch of a long-polling client widget's fetch (`logError`
  is server-only — for client-side polling, use the silent-recovery
  pattern in `live-money-chat.tsx` and surface the failure via a
  "Reconnecting…" status pill instead of console spam).

---

## React hooks safety

A handful of crashes in this codebase historically traced back to
hook-order violations (React error #310). The rule, restated:

- Never put a hook behind `if`, `else`, `try`, `for`, or any conditional.
- Never `return` before all hooks have been called.
- Never call hooks inside a callback that conditionally executes
  (`onClick={() => useSomething()}` is wrong).

When refactoring an existing component, count the hooks at the start
of the function — that count must NEVER change between renders.

---

## What error messages can NEVER include

These leak vectors apply to every layer (UI, toast, log, audit, JSON):

- Raw SQL fragments (Postgres errors include the failed SQL + params).
- Database connection strings.
- JWT tokens, TOTP secrets, recovery codes, API keys.
- Email bodies / TFA codes / Fireblocks transfer payloads in plain text.
- Stack traces in production responses (Next handles this — don't fight it).
- User-typed input echoed verbatim (XSS via toast / log injection).

When in doubt: log to the server with `logError` (which Vercel logs
ingest privately) and surface a generic message to the client.

---

## Quick checklist when adding a new admin page

- [ ] Server Component with `requirePageAccess(<route>)` at the top.
- [ ] Parallel queries wrapped in `safeQuery` if the page has > 1 tile
      that should survive independently.
- [ ] Heavy segments behind their own `<Suspense fallback={...}>`.
- [ ] One `error.tsx` for the new route (copy the pattern from
      `users/[id]/error.tsx`).
- [ ] All server actions return `ServerActionResult<T>`; clients
      check `result.success`.
- [ ] `tsc --noEmit` and `next lint` clean.
- [ ] No raw error strings interpolated into JSX content.

That's the whole protocol.
