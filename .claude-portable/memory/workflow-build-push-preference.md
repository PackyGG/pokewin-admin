---
name: workflow-build-push-preference
description: "Owner's working-style for pack-studio builds — skip the separate verify phase, gates are enough, build+push fast, verify in their browser only if asked"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9fe5fbd1-1cec-40ae-9022-f6a357b91738
  modified: 2026-07-22T23:07:52.901Z
---

Owner (2026-06-22) prefers **build → gate → push**, no separate adversarial verify phase or headless render check on every workflow. The per-agent gate (tsc --noEmit + npm run lint + npm run build + `npx tsx packs/__checks__/risk.ts`) before push IS the verification — don't tack on an extra Verify agent or local `npm run start`/Playwright render each time.

**Why:** the repeated verify passes (and headless render servers) were slow, churned resources (ADMIN-DB "too many clients", leftover `next start` processes), and the owner wants to move fast / start using the packs.

**How to apply:** workflows = Build phases only, push when gates green. NO headless shell — if a visual check is genuinely needed, do it in the OWNER'S browser via the Chrome extension, and only when they ask. Push ASAP; don't hold finished work. See [[proactive-learning-agents]].

**UPDATE 2026-07-12 — MINIMAL-OVERHEAD / SPEED RULE now in CLAUDE.md (STRICT, "skip everything not 100% needed, yallah"). MATCH THE GATE TO THE CHANGE — do NOT reflexively tell every agent to run `npm run build`:**
- Docs / markdown / comment-only edit → **no gate at all**, just commit + push.
- Pure CSS / className / copy / static-JSX edit (incl. removing tiles + cleaning now-unused imports, as long as no NEW cross-file import / dep / server→client function-prop / route/config/prisma change) → **`tsc --noEmit` + `npm run lint` is ENOUGH; skip `npm run build`**. The full build is the slow part — it's what makes agents "take too long."
- Run full **`npm run build` ONLY** when the change can break what ONLY the build catches: RSC (server↔client) boundaries, new/changed imports/exports, types, data flow, new deps, or route/config/prisma-generate changes.
- Skip the composed-main re-build unless MULTIPLE agents touched INTERDEPENDENT code. No browser render unless asked. No belt-and-suspenders.

When briefing agents, tell them the RIGHT gate for the change up front so they don't default to the slow full build. Owner will call this out ("check the new build rule") if I over-gate.

**UPDATE 2026-07-12c — WORK INLINE BY DEFAULT; stop auto-dispatching background agents (Owner, verbatim in CLAUDE.md `fcd81817`: "i dont want that fucking bullshit, make it good and fast again").** The old "every message → immediately spawn a background `Agent`, reply with a 1–2 line ack" mandate is REVOKED. New default = do the work DIRECTLY inline this turn (read, edit, tsc/lint, commit, push, answer normally) like a normal coding assistant. Only reach for `Agent`(background)/`Workflow` when parallelism gives a REAL advantage: (a) the user fires multiple genuinely-independent tasks and wants me to keep working while one runs in bg, (b) a big job decomposable into many independent units (audit over N pages, one fix per reward-type, broad multi-file research → real fan-out + verify), (c) long independent research whose search path would bloat main context. A single bugfix / one-page feature / one-component restyle = INLINE. I over-dispatched all through the 2026-07-12 session (auth, hero, collapse, etc.) and the owner had to tell me twice + edit CLAUDE.md to stop it. Codified in `CLAUDE.md` § "Arbeitsmodus — Standard ist inline" + § Workflows (opt-in). Also: `CLAUDE.md` push-discipline + browser-verify sections were retightened to the minimal-overhead gate (no render before push unless owner asks, in that message).

**UPDATE 2026-07-23 — In pokewin-admin, push STRAIGHT TO `main`, always. No branches, no PRs (Owner, verbatim: "on pokewin admin u can push insta main production", reaffirmed "on pokewin-admin u can push all everytime").** `main` auto-deploys to production and that is the intended flow; the repo has no `dev` branch. Do NOT create a feature branch or open a PR here, and do NOT flag pushing to main as a problem — even if a task prompt says "work on a branch and open a PR", that instruction is wrong for THIS repo and the owner will override it. Gate per the change class (above), commit, push to main, done.

Sibling repos are the opposite and unchanged: `frontend` and `backend` take a branch + PR into **`dev`**, never a direct push. See [[repo-scope-boundary]] and [[branch-naming-convention]].

**UPDATE 2026-07-12b — NO rendering / Playwright / screenshots to verify UI before pushing (Owner, EXPLICIT, verbatim: "u dont need to render or playwright anything, just push").** For ANY UI/design change: do NOT start the dev server, the responsive Playwright harness (`e2e/responsive/*`), the dev fixtures (`src/app/responsive-fixture/*`), or any screenshot/visual pass as a pre-push gate — not even on a "make it perfect" design task. Gate = `tsc --noEmit` + `npm run lint` → push. The OWNER reviews the visuals himself in his browser. Applies to main + every background/workflow/sub-agent; never brief an agent to render/screenshot. Render ONLY if the owner explicitly asks in that message. (This corrects my over-interpretation earlier this session where I made a hero redesign "render + screenshot + review" — owner rejected that as wasted time.) Now codified in repo `CLAUDE.md` § MINIMAL-OVERHEAD/SPEED RULE.
