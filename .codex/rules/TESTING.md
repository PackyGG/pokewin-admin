# Codex Testing Rules

Keep validation fast, practical, and proportional to the change.

## Default

For normal code changes, run the fastest relevant checks first:

```bash
npm run lint
npx tsc --noEmit
```

Run `npm run build` when:

* the change is large
* framework/build behavior may be affected
* lint/typecheck are not enough
* there were multiple errors or regressions
* the task is production-critical

Run targeted tests when relevant.

Do not run every test suite after every small change.

## Browser verification

Do not use browser verification by default.

Use browser verification only when:

* there are multiple frontend/UI errors
* the issue cannot be verified reliably from code/tests
* the task specifically requires visual behavior
* there is a suspected runtime/UI regression

Avoid unnecessary browser work for simple changes.

## Fixing issues

* Fix real lint/type errors properly.
* Do not globally disable rules just to pass checks.
* Do not make risky logic changes only to remove warnings.
* Prefer targeted fixes over broad rewrites.

## Speed

* Run independent checks in parallel when useful.
* Prefer targeted tests over full suites.
* Do not repeat expensive checks without a reason.
* If a previous check already proves an unaffected area is healthy, do not rerun it unnecessarily.

## Git and pushes

For writable repositories:

* keep changes focused
* inspect `git diff`
* commit completed work
* push promptly once the relevant checks pass
* do not hold finished changes locally unnecessarily
* direct push to `main` is allowed where defined in `RULES.md`

Do not push known broken code.

## Completion

A normal task is complete when:

* the requested change is implemented
* relevant lint/typecheck/tests pass
* the diff looks correct
* there are no known regressions

Use deeper verification only when the size or risk of the change justifies it.
