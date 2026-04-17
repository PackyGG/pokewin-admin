# E2E tests

End-to-end Playwright suite for the pokewin-admin panel. Tests drive a real
Next.js dev server through Chromium and talk to real Postgres databases —
no mocked fetches, no bypass auth, no faked session cookies.

---

## Quick start

```bash
# One-time setup: seed the dedicated E2E admin account.
# Prints a TOTP secret on first run — pin it into .env.local.
npm run test:e2e:seed

# Run the whole suite headless.
npm run test:e2e

# Interactive UI runner — best for iterating on a flaky test.
npm run test:e2e:ui

# Headed mode (watch the browser do the thing).
npm run test:e2e:headed

# A single spec file.
npx playwright test e2e/tests/auth.spec.ts

# A single test by name.
npx playwright test -g "valid credentials"

# Reuse an already-running dev server instead of booting one.
E2E_USE_EXISTING_SERVER=1 npm run test:e2e
```

After a failed run, open the HTML report:

```bash
npx playwright show-report
```

---

## Required env vars

Copy the relevant values into `.env.local` (never commit it). Playwright's
global setup loads `.env`, `.env.local`, `.env.test`, and `.env.test.local`
in that order — later files win, and values already set in the shell
always beat file values.

| Var                       | What it's for                                                               | Required? |
|---------------------------|------------------------------------------------------------------------------|-----------|
| `DATABASE_URL`            | Main DB connection. Tests create/delete scratch users here.                  | Yes       |
| `ADMIN_DATABASE_URL`      | Admin DB connection. Tests seed the E2E admin and read roles here.           | Yes       |
| `SESSION_SECRET`          | JWT signing key — must match what the app uses so cookies are readable.      | Yes       |
| `E2E_ADMIN_EMAIL`         | Login email for the seeded admin. Default: `e2e-admin@test.local`.           | No        |
| `E2E_ADMIN_USERNAME`      | Username for the seeded admin. Default: `e2e_admin`.                         | No        |
| `E2E_ADMIN_PASSWORD`      | Password for the seeded admin. Default: `E2EAdmin!Pass123`.                  | No        |
| `E2E_ADMIN_TOTP_SECRET`   | Base32 TOTP secret. Printed by `test:e2e:seed` on first run — copy it in.    | Yes       |
| `E2E_BASE_URL`            | Override the default `http://localhost:3000`.                                | No        |
| `E2E_USE_EXISTING_SERVER` | Set to `1` to reuse a dev server you started manually.                       | No        |

**Never point `DATABASE_URL` at production.** The suite creates and deletes
users by prefix (`_e2e_*`). It only ever touches rows matching that prefix,
but running against production would still write audit events and ledger
transactions for every balance-adjustment test.

---

## How a test is wired

Every spec imports `test` and `expect` from `../fixtures/base`. The
fixtures give you:

- `adminPage` — a logged-in `Page`, already past the 2FA screen. Real
  form submission, real session cookie, real middleware pass-through.
- `makeScratchUser()` — creates a `_e2e_*` user on the main DB and
  registers it for automatic deletion when the test ends.
- `adminCredentials` / `adminTotpSecret` — raw values if you need to
  drive the login form yourself.

A typical test looks like this:

```ts
import { test, expect } from "../fixtures/base";

test.describe("my feature", () => {
  test("does the thing", async ({ adminPage, makeScratchUser }) => {
    const user = await makeScratchUser();

    await adminPage.goto(`/users/${user.id}`);
    await adminPage.getByRole("button", { name: /do the thing/i }).click();

    await expect(adminPage.getByText(/success/i)).toBeVisible();
  });
});
```

---

## Philosophy (read before adding tests)

- **One flow per file.** Split specs by feature area, not by component.
  `auth.spec.ts` covers login + logout + redirects — not "every form".
- **Real login, real UI interactions.** No `setCookie()`, no
  bypass-auth routes, no `page.evaluate(() => fetch(...))` to
  short-cut past the server. If a test would pass by skipping auth,
  it isn't testing what users actually experience.
- **Assert something specific.** "Page loads" isn't a test. Every
  assertion should fail in at least one realistic breakage scenario:
  a missing column, a broken server action, a stale cache.
- **Use user-visible locators.** `getByRole`, `getByLabel`,
  `getByText` over CSS classes. If a locator needs `data-testid`,
  add it sparingly to production code with a comment explaining why.
- **No arbitrary `waitForTimeout`.** Wait for conditions:
  `waitForURL`, `expect(locator).toBeVisible()`, `waitForResponse`.
  Timeouts hide race conditions and they bite on CI.
- **Database assertions over DOM-only.** If a test mutates state,
  read the state back from Postgres to prove the write committed.
  See `getUserBalance` / `getUserRole` in `helpers/db.ts`.
- **Clean up.** If your test creates data, either use a fixture
  teardown or add to the `afterAll` sweepers in `helpers/db.ts`.

---

## CI

The GitHub Actions workflow (`.github/workflows/e2e.yml`) is currently
`workflow_dispatch` only — it needs a stable test database and the set of
`E2E_*` secrets. See the comment at the top of that file for how to
promote it to `push`/`pull_request` triggers once the DB story is settled.

---

## Troubleshooting

**`E2E_ADMIN_TOTP_SECRET is not set`**
Run `npm run test:e2e:seed`, copy the printed secret into `.env.local`,
and re-run.

**`Timed out waiting for /verify-2fa`**
The TOTP code computed by the test disagreed with the one the server
expected. Nine times out of ten this is clock skew — run
`w32tm /resync` on Windows or check `timedatectl` on Linux.

**Tests pass locally, fail on CI**
Check the uploaded `playwright-report/` artifact from the failed run.
Traces are captured on first retry — open them with
`npx playwright show-trace path/to/trace.zip` locally.

**Scratch users leaking**
If a run crashes mid-test, stragglers can pile up. `global-setup.ts`
sweeps them at the start of every run, but you can also force a
cleanup with:

```bash
npx tsx -e 'import("./e2e/helpers/env").then(m => m.loadEnvFiles()); import("./e2e/helpers/db").then(async (m) => { const n = await m.sweepStaleScratchUsers(); console.log(`swept ${n}`); await m.closePools(); })'
```
