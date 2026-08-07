# Codex Infrastructure Rules

These rules cover GitHub, Vercel, Railway, deployments, environment variables, local configuration, and repository infrastructure access.

## General

Use available infrastructure tools proactively when they help complete or verify a task.

Codex may manage infrastructure and environment configuration only for repositories explicitly granted write access below.

Never expose secret values in responses, logs, documentation, commits, or generated files.

Do not make destructive infrastructure changes unless explicitly authorized.

## Infrastructure write access

FULL infrastructure/config write access is allowed ONLY for:

* `pokewin-admin`
* `antifraud-backend`
* `discord-bot`

For these repositories, Codex may manage:

* Vercel configuration
* Railway configuration
* local environment configuration
* environment variables
* deployment configuration
* service configuration
* project configuration
* build/runtime settings
* related infrastructure configuration required by the application

For all other repositories, infrastructure and environment configuration is READ ONLY unless the owner explicitly authorizes changes.

## Environment variables

For `pokewin-admin`, `antifraud-backend`, and `discord-bot`, Codex may:

* inspect environment-variable names and values when required
* create environment variables
* update environment variables
* rotate or replace values when required by the task
* remove verified obsolete variables
* rename variables
* synchronize variables between local development and hosted environments
* synchronize variables between related services where appropriate
* clean duplicate/stale environment-variable definitions
* reorganize environment configuration
* correct inconsistent variable names
* ensure required variables exist in the correct environments

Before deleting or renaming an environment variable:

* search the repository for all usages
* inspect deployment and service references
* identify dependent services
* update all relevant code/configuration
* preserve production behavior

Never expose secret values unnecessarily.

Never commit real secrets to Git.

## Local environment files

For the three writable repositories, Codex may manage local environment files including:

* `.env`
* `.env.local`
* `.env.development`
* `.env.production`
* `.env.test`
* `.env.example`
* repository-specific environment/config files

Codex may:

* create missing environment files
* add required variables
* update local values
* remove verified stale variables
* clean duplicate entries
* reorganize/group variables
* synchronize variable names with deployed environments
* update `.env.example`
* update `.gitignore` when needed to prevent secret files from being committed

Secret-bearing env files must remain gitignored unless explicitly intended to be version-controlled.

`.env.example` and similar tracked templates must contain placeholders, never real secrets.

## Vercel

For writable repositories connected to Vercel, Codex may:

* inspect projects
* inspect deployments
* inspect build logs
* inspect runtime logs
* inspect configuration
* inspect environment variables
* create environment variables
* update environment variables
* remove obsolete variables when verified safe
* manage Development variables
* manage Preview variables
* manage Production variables
* update project settings
* optimize project configuration
* create preview deployments
* deploy to production when appropriate
* redeploy when required
* investigate and fix deployment failures

Before making production changes:

* verify the correct Vercel team
* verify the correct project
* verify the target environment
* inspect relevant code/configuration
* ensure variable changes will not break dependent services

Do not:

* delete Vercel projects without explicit authorization
* delete domains without explicit authorization
* expose secrets

## Railway

For writable repositories/services connected to Railway, Codex may:

* inspect projects
* inspect environments
* inspect services
* inspect deployments
* inspect build/runtime logs
* inspect configuration
* inspect environment variables
* create variables
* update variables
* remove verified obsolete variables
* modify service configuration
* optimize service configuration
* restart services
* redeploy services
* deploy new verified changes
* investigate and fix failed deployments

Before modifying Railway configuration:

* verify the correct workspace
* verify the correct project
* verify the correct environment
* verify the correct service
* inspect dependent/shared variables
* ensure database permissions are respected

Do not:

* delete Railway projects without explicit authorization
* delete services without explicit authorization
* delete databases without explicit authorization
* delete volumes without explicit authorization
* expose secret values

## GitHub

Repository permissions are defined in `.codex/RULES.md`.

For repositories with full access, Codex may:

* inspect branches
* inspect commits
* inspect pull requests
* inspect checks
* create commits
* push changes
* create branches when useful
* open pull requests when useful
* push directly to `main` where allowed by `RULES.md`

Do not:

* force-push unless explicitly requested
* rewrite Git history
* delete repositories
* modify unrelated repository settings
* discard unrelated user changes

## Deployments

For full-access repositories, Codex may deploy completed and verified work.

Production deployment is allowed for:

* `pokewin-admin`
* `antifraud-backend`
* `discord-bot`

Before deployment:

* confirm the target repository
* confirm the target project/service
* inspect the final diff
* run proportional validation
* confirm required environment variables exist
* verify database permissions
* ensure no secrets are accidentally exposed
* avoid deploying known broken/incomplete work

Deploy promptly when the task is complete and the relevant checks pass.

Do not unnecessarily delay completed deployments.

## Configuration cleanup

For writable repositories, Codex may autonomously improve infrastructure/configuration quality.

This includes:

* removing verified stale variables
* consolidating duplicate variables
* standardizing variable naming
* removing obsolete configuration
* simplifying deployment configuration
* cleaning old project settings
* correcting inconsistent local/hosted config
* optimizing build/runtime settings
* improving environment organization

Do not delete or change configuration solely because it looks unused.

Verify all references first.

## Cross-service configuration

When a change affects multiple writable services, Codex may coordinate the required updates across:

* `pokewin-admin`
* `antifraud-backend`
* `discord-bot`
* their Vercel/Railway configuration
* their local environment files

Keep shared configuration consistent when appropriate.

Do not propagate a variable or configuration change to unrelated services unless needed.

## Read-only repositories

For repositories not explicitly listed as infrastructure-writable:

Codex may:

* inspect environment-variable names
* inspect infrastructure configuration
* inspect deployment settings
* inspect logs
* use configuration as technical context

Codex must NOT:

* change environment variables
* change Vercel configuration
* change Railway configuration
* modify local env files
* deploy
* restart production services
* alter infrastructure

unless the owner explicitly authorizes it.

## Parallel agents

Parallel agents may inspect infrastructure concurrently when useful.

Do not allow multiple agents to simultaneously:

* modify the same production environment variables
* deploy competing versions
* change the same Railway service
* modify the same Vercel production configuration
* perform conflicting infrastructure operations

Production/configuration writes must be coordinated through a single primary agent/workstream.

## Safety

Before any production-impacting infrastructure change:

* verify the exact target
* understand the impact
* inspect dependencies
* confirm repository permissions
* confirm database permissions
* preserve existing production behavior
* prefer reversible changes when practical

Never expose or commit:

* passwords
* database connection strings
* API keys
* private keys
* access tokens
* session secrets
* webhook secrets
* other sensitive credentials
