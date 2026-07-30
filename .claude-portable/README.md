# .claude-portable — Claude Code setup that travels with the repo

Snapshot of the Claude Code config that normally lives **outside** the repo
(under `~/.claude/`) and therefore would not come along on a fresh device.
Everything here is a copy — the live files are still the ones under `~/.claude/`.

Repo-level rules (`CLAUDE.md`, `AGENTS.md`, `AGENT_HANDOFF.md`,
`AGENT_HANDOFF_ARCHIVE.md`, `ONBOARDING.md`, `SESSION_MEMORY.md`, `docs/**`)
are already tracked normally at the repo root — nothing to restore for those.

## What's in here

| Path | Live location | What it is |
|---|---|---|
| `global/CLAUDE.md` | `~/.claude/CLAUDE.md` | Global response-style rules (all projects) |
| `global/settings.json` | `~/.claude/settings.json` | Global Claude Code settings |
| `memory/` | `~/.claude/projects/<project-slug>/memory/` | Persistent memory for this project (incl. `MEMORY.md` index) |
| `launch.json` | `.claude/launch.json` | Dev-server config (`.claude/` is gitignored) |

`<project-slug>` is the working directory with separators replaced by `-`, e.g.
`C--Users-motha-Documents-GitHub-pokewin-admin` on Windows.

## Restore on a new device

After cloning the repo, from the repo root:

```bash
mkdir -p ~/.claude/projects/C--Users-motha-Documents-GitHub-pokewin-admin/memory && cp .claude-portable/global/CLAUDE.md ~/.claude/CLAUDE.md && cp .claude-portable/global/settings.json ~/.claude/settings.json && cp .claude-portable/memory/*.md ~/.claude/projects/C--Users-motha-Documents-GitHub-pokewin-admin/memory/ && mkdir -p .claude && cp .claude-portable/launch.json .claude/launch.json
```

If the clone path differs, rename the project-slug folder to match the new path.

## Not included (on purpose)

`.env` / any secret, `~/.claude/.credentials.json`, sessions, telemetry,
shell snapshots, worktrees, plugin caches, and memory for other projects.

## Keeping it fresh

This is a manual snapshot — re-copy before switching devices, or just ask
Claude to "update .claude-portable".
