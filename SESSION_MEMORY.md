# SESSION_MEMORY.md — doc protocol

Rewritten 2026-08-05. The previous version forced every agent to read the handoff + onboarding docs
at session start and to write a narrative entry after every task. That is what grew
`AGENT_HANDOFF.md` to 222 KB and burned ~85k tokens of context before any real work started. It is
replaced by the rules below.

## Reading

**Nothing is mandatory on session start.** `CLAUDE.md` loads automatically and is the rulebook. Open
anything else only when the task actually needs it:

| Need | File |
|---|---|
| Is anything in flight / blocked / file-locked right now? | `AGENT_HANDOFF.md` |
| Domain math, money model, non-obvious contracts | `ONBOARDING.md` |
| Query, caching, streaming mechanics | `docs/BACKEND_QUERY_SYSTEM.md` |
| Fraud / Fiat / KYC / Discord / Whop contracts | `docs/ANTIFRAUD_CONTRACTS.md` |
| Forensic detail on old work | `AGENT_HANDOFF_ARCHIVE.md` · `git log` |

## Writing

**Default: write nothing.** The commit message is the record of what shipped — git already keeps it
searchably. Do not narrate finished work into a markdown file.

Write only in these three cases:

1. **You are pausing mid-task, blocked, or holding a shared file** → add one entry to
   `AGENT_HANDOFF.md`, and delete it when the work lands.
2. **You learned a durable fact** that is not visible in the code (domain math, a backend contract, a
   money rule) → add it to `ONBOARDING.md`.
3. **The owner set a new binding rule** → add it to `CLAUDE.md`.

## Caps (enforced, not aspirational)

- `AGENT_HANDOFF.md` ≤ 200 lines. Over the cap → delete the oldest entries. Never archive-and-regrow.
- Never append dated session-log entries to any doc. That pattern is what caused the bloat.
- Never store secrets, tokens, or `.env` values in any doc.
