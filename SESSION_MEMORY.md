# SESSION_MEMORY.md — doc protocol

Rewritten 2026-08-05; Cursor-speed note 2026-08-06. The old protocol forced every agent to
read handoff + onboarding at session start and to narrate every task into markdown. That grew
`AGENT_HANDOFF.md` to 222 KB and burned ~85k tokens before real work. Do not bring that back.

## Cursor speed (owner answer)

- A compact on-demand board (≤200 lines) is a **good** idea.
- Cursor gets slower when **alwaysApply** rules force-load huge files every turn — not because
  `AGENT_HANDOFF.md` exists.
- Never put "read AGENT_HANDOFF before every tool call" in always-applied Cursor rules.
- Prefer **git history** + open the board only when in-flight / blocked / locks matter.
- Keep the board a board — never a changelog.

## Reading

**Nothing is mandatory on session start.** `CLAUDE.md` loads automatically. Open anything else
only when the task needs it:

| Need | File |
|---|---|
| In flight / blocked / file-locked right now? | `AGENT_HANDOFF.md` |
| Domain math, money model, non-obvious contracts | `ONBOARDING.md` |
| Query, caching, streaming | `docs/BACKEND_QUERY_SYSTEM.md` |
| Fraud / Fiat / KYC / Discord / Whop | `docs/ANTIFRAUD_CONTRACTS.md` |
| Forensic detail on old work | `AGENT_HANDOFF_ARCHIVE.md` · `git log` |

## Writing

**Default: write nothing.** The commit message is the record — git already keeps it.

Write only when:

1. **Pausing mid-task, blocked, or holding a shared file** → one entry in `AGENT_HANDOFF.md`;
   delete it when the work lands.
2. **Durable fact** not visible in code → `ONBOARDING.md`.
3. **New binding rule** → `CLAUDE.md`.

## Caps

- `AGENT_HANDOFF.md` ≤ 200 lines. Over cap → delete oldest entries. Never archive-and-regrow.
- Never append dated session-log entries. Never store secrets or `.env` values in docs.
