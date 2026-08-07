# Codex Repository Rules

These rules apply to Codex only.

## Autonomy and execution

* Work autonomously and complete tasks end-to-end.
* Do not stop at planning, auditing, or recommendations unless explicitly asked for only a plan.
* Investigate first, then act.
* Prefer fixing problems directly instead of only explaining them.
* Preserve existing behavior unless the requested task requires changing it.
* Prefer simple, maintainable solutions over clever or unnecessary abstractions.
* Follow existing repository conventions when they are reasonable.
* Do not create unnecessary Markdown reports, audit files, handoff files, session-memory files, or temporary documentation.

## Parallel agents and workflows

* When a task can be completed faster or more reliably through parallel work, use available agents, subagents, workflows, tools, and parallel execution aggressively.
* Use as many parallel agents/subagents as are genuinely useful.
* Split large tasks into independent workstreams when this reduces completion time or improves verification.
* Good parallel work includes:

  * repository investigation
  * codebase searches
  * architecture analysis
  * testing
  * lint/typecheck/build verification
  * browser verification
  * dependency analysis
  * log inspection
  * security review
  * code review
* Do not create extra agents merely for the sake of using more agents.
* Avoid multiple agents editing the same files or tightly coupled code at the same time.
* When multiple agents modify code, divide ownership by clearly separated files, modules, services, or worktrees.
* The primary agent is responsible for integrating results, resolving conflicts, running final validation, and ensuring the combined result is coherent.
* Independent agents may investigate the same problem from different angles when this materially improves confidence.
* Use specialized workflows/tools when they are better suited than handling everything manually.
* Run independent validation steps in parallel when practical.
* Do not sacrifice correctness, repository safety, or verification quality for speed.
* Never allow competing production deployments or conflicting database/schema changes from parallel agents.
* Production-impacting actions must remain coordinated.

## Investigate before asking

* Prefer inspecting the repository, configuration, Git history, logs, schemas, connected services, and existing technical documentation before asking the owner questions.
* Do not ask for information that can reasonably be discovered with available tools.
* If uncertainty remains, prefer the safest reversible option where possible.
* Ask the owner only when a missing decision materially changes product behavior, business logic, permissions, or could cause a destructive or dangerous action.
* Never invent database structure, infrastructure, credentials, business rules, or service behavior.

## Repository permissions

Repository permissions are strict.

### pokewin-admin

FULL ACCESS.

Codex may:

* read all files
* modify code
* create files
* delete verified obsolete files
* refactor
* run scripts, tests, lint, typecheck, and builds
* commit changes
* push directly to `main`
* deploy to production when appropriate for the task

This repository and its contained admin/antifraud code are trusted writable code.

### antifraud-backend

FULL ACCESS.

Codex may:

* read
* modify
* refactor
* commit
* push directly to `main`
* deploy to production when appropriate

### frontend repository

READ ONLY by default.

Codex may:

* inspect code
* search code
* analyze architecture
* compare implementations
* use it as technical context

Codex must NOT:

* modify files
* commit
* push
* open a PR

unless the owner explicitly authorizes changes.

If changes are explicitly authorized, use a pull request unless the owner explicitly authorizes direct push.

### backend repository

READ ONLY by default.

Codex may:

* inspect code
* search code
* analyze implementation
* use it for integration or domain context

Codex must NOT:

* modify files
* commit
* push
* open a PR

unless the owner explicitly authorizes changes.

If changes are explicitly authorized, use a pull request unless the owner explicitly authorizes direct push.

### discord-bot repository

FULL ACCESS.

Treat the Discord bot repository with the same repository permissions as `pokewin-admin`.

Codex may:

* read
* modify
* refactor
* commit
* push directly to `main`
* deploy when appropriate

The Discord bot may use the same approved services and data sources as `pokewin-admin`, subject to the database permissions below.

## Database permissions

Database permissions are strict.

Before any database-changing operation, identify exactly which database is targeted and verify that writes are allowed.

### Admin database

FULL ACCESS.

Codex may:

* read data
* write data when required
* modify schema
* create and modify indexes
* consolidate redundant indexes
* optimize indexes
* create reviewed migrations
* optimize queries
* perform maintenance required by the admin system

Schema/data changes must still be deliberate and verified.

### Production PostgreSQL database

STRICTLY READ ONLY.

Codex may:

* inspect schema
* run SELECT queries
* inspect indexes
* inspect query plans when safe
* use it to understand production behavior

Codex must NEVER:

* INSERT
* UPDATE
* DELETE
* ALTER
* DROP
* TRUNCATE
* CREATE indexes
* run migrations
* push schema changes
* change permissions
* modify production data in any way

Never run schema-push tooling against the production PostgreSQL database.

### Production PostgreSQL mirror database

This is the preferred source for production data reads and analytics.

Rules:

* Prefer the mirror over the production PostgreSQL database for production data reads.
* Use the mirror for heavy analytics/query workloads where appropriate.
* Do not assume writes are allowed unless explicitly configured.
* Do not run destructive operations.
* Inspect current infrastructure/configuration before changing mirror schema or behavior.

### Antifraud database

FULL ACCESS.

Codex may:

* read
* write
* modify schema
* create migrations
* create or modify indexes
* consolidate redundant indexes
* optimize queries
* optimize database structure

Preserve antifraud behavior and data integrity.

## Data access preference

When applicable, prefer:

1. Production mirror database for production data reads and analytics.
2. Admin database for admin-owned state/configuration.
3. Antifraud database for antifraud-owned state.
4. Production PostgreSQL only when information cannot safely be obtained elsewhere or direct inspection is specifically required.

Avoid unnecessary load on the production PostgreSQL database.

## Database safety

Before executing a database-changing command:

* identify the exact target database
* verify write permission
* inspect relevant schema/migrations
* understand the expected impact
* choose the least destructive approach
* confirm the operation is reversible where practical

Never guess which database a connection string points to.

Never expose connection strings, passwords, tokens, API keys, private keys, or secret environment-variable values.

Never commit secrets.

## Code quality

* Keep TypeScript strongly typed.
* Fix ESLint/type issues properly instead of hiding them with broad disables.
* Avoid unnecessary `any`.
* Remove dead code only after verifying it is genuinely unused.
* Search the repository before adding new utilities, helpers, services, components, abstractions, or types that may already exist.
* Reduce duplication when consolidation creates a genuinely better abstraction.
* Prefer understandable duplication over a bad abstraction.
* Keep related functionality together.
* Improve separation of concerns where it clearly improves maintainability.
* Avoid giant rewrites when smaller safe changes accomplish the task.
* Do not reorganize working code purely for cosmetic reasons.
* Do not introduce a new framework, ORM, state manager, build system, monorepo manager, or major architectural pattern without a concrete reason.

## Before deleting code

Before deleting a file, function, export, dependency, endpoint, config entry, script, or significant block of code, search for:

* static references
* dynamic imports
* framework conventions
* API routes
* background jobs
* webhooks
* scripts
* migrations
* tests
* generated code
* deployment entrypoints
* runtime configuration

Do not delete something solely because an automated tool reports it unused.

## Git behavior

For writable repositories:

* inspect `git status` before significant work
* inspect `git diff` frequently
* keep unrelated user changes untouched
* commit meaningful completed work
* push completed work when appropriate
* direct push to `main` is allowed for:

  * `pokewin-admin`
  * `antifraud-backend`
  * `discord-bot`

Do not:

* force-push unless explicitly requested
* rewrite existing Git history
* discard unrelated changes
* reset unrelated user work
* modify read-only repositories without authorization

## Production and deployments

For full-access repositories, Codex may deploy completed and verified work to production when appropriate.

Before production deployment:

* run relevant validation
* confirm the relevant build succeeds
* inspect the final diff
* verify database/schema changes target only approved writable databases
* verify no secrets are exposed
* avoid deploying known broken or incomplete work

Do not deploy from read-only repositories without explicit authorization.

Do not delete projects, services, domains, databases, or volumes unless explicitly instructed.

## External services

Codex may use configured GitHub, Vercel, Railway, browser/testing, database, and other development tooling when relevant.

Use those tools proactively when they help verify or complete the task.

Do not expose secret values from external services.

Do not make destructive infrastructure changes unless explicitly authorized.

Detailed infrastructure behavior is defined in `.codex/rules/INFRA.md`.

## Validation

A task is not complete merely because code was written.

After meaningful changes, run the relevant validation defined in `.codex/rules/TESTING.md`.

Where applicable verify:

* lint
* TypeScript/typecheck
* tests
* build
* runtime behavior
* browser behavior
* database queries
* deployment state

Fix regressions before considering the task complete.

If something cannot be verified, clearly state exactly what remains unverified.

## Frontend/browser verification

For meaningful visible frontend changes:

* start or reuse the development server
* open the affected application
* test the affected flow
* inspect browser console errors
* inspect failed network requests
* check obvious visual regressions
* verify important interactions
* fix discovered regressions before finishing

Do not claim a frontend task is complete solely because lint, TypeScript, or build passes.

## Refactoring and cleanup

Codex may autonomously:

* remove verified dead code
* remove unused dependencies
* consolidate duplicate implementations
* improve folder/file organization
* split oversized modules where beneficial
* simplify confusing abstractions
* improve imports
* improve type safety
* optimize queries
* optimize indexes on writable databases
* improve maintainability
* improve architecture where there is a clear benefit

Work incrementally.

Keep the repository working throughout major refactors.

## Rule files

General Codex behavior is defined here.

Additional rules:

* database/environment work → `.codex/rules/DATABASE.md`
* validation/testing/browser work → `.codex/rules/TESTING.md`
* GitHub/Vercel/Railway/infrastructure work → `.codex/rules/INFRA.md`

Do not treat `CLAUDE.md`, `.claude/`, `.claude-portable/`, or other agent-specific files as Codex behavioral instructions.

Other documentation may be consulted only as technical context when genuinely relevant to the current task.

## Completion standard

Before saying a substantial task is complete:

* verify the requested behavior
* inspect the final diff
* run relevant validation
* confirm no unintended regressions
* verify important production/infrastructure implications
* ensure all changes comply with repository and database permissions

If verification succeeds, finish the task and summarize the result concisely.

If verification cannot be completed, do not pretend it was completed. State the exact limitation and what was verified.
