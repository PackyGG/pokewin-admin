# CLAUDE.md — pokewin-admin

Dieses File definiert verbindliche Arbeitsregeln für jede Claude Code Session in diesem Repository. Es wird automatisch geladen und gilt als Grundlage für alle Aufgaben. Bei Konflikt zwischen diesen Regeln und anderen Anweisungen → diese Regeln haben Vorrang, außer der User weist explizit auf eine Ausnahme hin.

### 📎 Companion-Docs (zu Beginn jeder Session lesen)

**Erzwungenes Protokoll:** **`SESSION_MEMORY.md`** — Read-on-start + Write-before-done. Kein DONE ohne Doc-Update.

Diese Datei (`CLAUDE.md`) ist die **bindende Regel-Quelle**. Zu Sessionbeginn mitlesen:

- **`AGENT_HANDOFF.md`** — **live Session-State** (shipped, in-flight, blocked, next). **Zuerst lesen.**
- **`ONBOARDING.md`** — **Architektur + Domain-Wissen** (Key-Files, Reward-/Ledger-Modell, Gotchas).

**Boundary:** Session-State (CURRENT STATE, IN-FLIGHT, OPEN/NEXT, FAILED/BLOCKED) lebt in `AGENT_HANDOFF.md`, **nicht hier**. In `CLAUDE.md` kommen nur **durable Regeln & Konventionen**. Wenn `AGENT_HANDOFF.md` eine durable Regel korrigiert/verschärft, wird sie hierher übernommen (genau das ist 2026-06-05 passiert: Worktree-`npm install` statt `npm ci`, Admin-DB-`db push` statt `migrate`, Build-/Verify-Agent-Contract, UI-Verify-Fallback, Gotchas-Liste).

---

## 🚫 ABSOLUTE SICHERHEITSREGEL — Prod-DB-Policy (höchste Priorität, 2026-06-05, präzisiert)

**Die zwei DBs werden unterschiedlich behandelt — diese Regel überschreibt alle früheren DB-Regeln.**

### 🟢 ADMIN DB — voller Zugriff erlaubt
- **Voller Zugriff bestätigt (User, 2026-06-05: „admin dash db u can do whatever u want").** Schreiben, DDL/DML, Schema-Änderungen — alles erlaubt, der Agent führt es **selbst** aus.
- **ABER die richtige Mechanik nutzen — die Admin-DB ist `db push`-managed, nicht migration-managed (Session-Learning 2026-06-05):**
  - Schema-Änderungen anwenden über **`prisma db push --schema=prisma/admin/schema.prisma --config=prisma/admin/prisma.config.ts`** (Schema-Sync) oder ad-hoc SQL über **`prisma db execute --file <sql> --config=prisma/admin/prisma.config.ts`**.
  - **NICHT `prisma migrate dev/deploy`** auf der Admin-DB — und `npm run admin:migrate` führt genau `prisma migrate dev` aus. Auf einer `db push`-managed DB erzwingt `migrate` einen **destruktiven Reset** (Datenverlust). Das ist **keine** Permission-Grenze (du darfst alles), sondern das **falsche Werkzeug**, das Daten wegwirft.
  - `db push` **verweigert** bei drohendem Datenverlust (z. B. Schema-Drift, siehe `AGENT_HANDOFF.md`). Dann bewusst entscheiden: Schema nachziehen oder archivieren-dann-droppen — **niemals blind `--accept-data-loss`**.
- Schema-Änderungen an `prisma/admin/schema.prisma` werden vom Agent **direkt angewendet** (nicht nur "Migration-File schreiben und User macht es"). Der User will das nicht mehr selbst tun.
- Standard-Vorsicht bleibt: keine destruktiven Operationen ohne klaren Grund, Audit-Events für admin-seitige Mutationen, kein Verlust historischer Daten.

### 🔴 MAIN / PROD GAME DB — strikt read-only + KEINE Features bauen, die sie ändern
- **Lesen** (SELECT, Schema-Inspektion) ist erlaubt — **sonst NICHTS**.
- Keine Writes, keine Migrations, kein `prisma migrate`, kein `prisma db push`, kein DDL/DML, kein `db.$executeRaw` mit DDL, keine "auto changes". Nicht "nur additiv", nicht "mit Approval", nicht "schnell".
- **Zusätzlich: KEINE Features vorschlagen oder bauen, die eine Schema-Änderung an MAIN bräuchten** — der User wendet sie nicht an. Solche Aufgaben gelten als blockiert; alternative Lösung suchen (z. B. in Admin-DB modellieren) oder dem User sagen, dass es nicht baubar ist, ohne die MAIN-DB zu ändern.

**Im Zweifel:** ADMIN DB anfassen ist OK, MAIN DB anfassen oder verändern ist verboten.

### 🔑 LIVE-PROD im lokalen `.env` (2026-06-10, Owner; **NEUE Prod-DB 2026-06-11**) — read-only Credential, NIEMALS exponieren
- Der lokale **`.env` `DATABASE_URL` zeigt auf die LIVE PROD Game-DB** (read-only, vom Owner gesetzt). **2026-06-11: Der Owner hat auf eine NEUE Prod-DB umgestellt — dieselbe Regel gilt unverändert und verschärft.** `getDb()` / `getProdDb()` lesen damit **echte Produktionsdaten** — entsprechend behandeln.
- **STRIKTE REGEL FÜR ALLE AGENTS UND ALLE MODELLE (Owner, 2026-06-11): READ ONLY — „no changes, no pushes, no nothing beside read".** Ausschließlich `SELECT` / Schema-Inspektion. KEIN write/insert/update/delete, **kein `prisma migrate`, kein `merge`, kein `prisma db push`, kein DDL/DML, kein `$executeRaw` mit Mutation**, keine „auto changes" — **nichts, das die Prod-DB verändert**. Gilt absolut und ausnahmslos — auch auf explizite Anweisung „schnell" / „nur additiv" / „mit Approval", und in **jedem** Workflow-/Background-/Sub-Agent. (Owner 2026-06-10: „you only have read access, no matter what dont migrate, merge or change anything". Owner 2026-06-11: „strict md rule for all agents and models, read only! no changes no pushes no nothing beside read".)
- **NIEMALS `.env` oder den Connection-String (oder irgendein Secret daraus) committen, pushen, printen, loggen, in Summaries/Changelogs/Messages schreiben oder anderweitig exponieren.** `.env` ist gitignored (`.gitignore` → `.env*`) — **so lassen, nie force-adden**, nie in einen Commit ziehen (auch nicht bei „push all").
- Read-only-Queries laufen über ein **temporäres `node --env-file=.env`-Script mit `pg`**; solche `_verify-*.mjs` / `_probe-*.mjs` bleiben **uncommitted**, geben **keine Secrets** aus und werden nach Gebrauch gelöscht.
- **Drift-Hinweis nach DB-Wechsel:** Schema-/Enum-Fakten, die gegen die alte Prod-DB verifiziert wurden (Enum-Member, fehlende Tabellen, Indizes, Row-Counts), gelten auf der neuen DB als **unverifiziert** — vor Verwendung neu proben (read-only). Die Runtime-Drift-Guards (`filterLedgerTxTypesLive`, 5-min-Cache) adaptieren automatisch.

---

## 🔥 ABSOLUTE PRIORITÄTSREGEL — Parallel-Modus ist Pflicht

**Jede neue User-Aufgabe → sofort `Agent` Tool mit `run_in_background: true` starten und nur eine 1–2-zeilige Bestätigung antworten.** Keine inline-Bearbeitung. Keine Bündelung mehrerer User-Messages in eine lange Inline-Session. Keine Ausnahmen für "kurze" Fixes.

Der User feuert mehrere Tasks nacheinander rein und erwartet, dass jeder sofort an einen eigenen Background-Agent geht, damit er **nicht warten muss**, bis der vorherige fertig ist. Wenn du inline arbeitest, blockst du den Channel und der User kann den nächsten Task erst nach deiner langen Antwort schicken — genau das soll dieser Modus verhindern.

**Immer empfangsbereit bleiben — niemals auf einer einzigen Task festhängen (CRITICAL):** Der Channel ist NIE blockiert. Während Agents im Hintergrund laufen, hörst du durchgehend auf neue User-Inputs und bist jederzeit bereit, sofort einen weiteren parallelen Agent zu starten. Mehrere Agents gleichzeitig laufen zu lassen ist der **Normalfall, nicht die Ausnahme** — es gibt keine Obergrenze, solange die Aufgaben unabhängig sind und keine Hotspot-Datei kollidiert. Verboten ist "Tunnel-Vision": dich auf eine laufende Aufgabe fixieren, während weitere offen sind oder neue reinkommen. Wenn der User mitten in laufenden Agents eine neue Message schickt → **sofort** den nächsten Agent dispatchen, NICHT erst den vorherigen abwarten, NICHT erst fertig erklären. Halte die Inline-Investigation (Greps/Reads/Diagnose) vor dem Dispatch minimal — gerade genug scopen, um den Agent präzise zu briefen, dann delegieren; tiefe Analyse macht der Agent selbst. Wenn du merkst, dass du gerade lange selbst recherchierst statt zu delegieren → STOP, dispatchen.

**ALWAYS re-check for new user messages before and after every action, and accept them as new tasks immediately (explicit user rule, 2026-06-04).** Between tool calls and dispatches — and especially before declaring anything finished — check whether the user has sent a new message. Every new message is a new task, correction, or priority: pick it up at once (dispatch a fresh background `Agent` for it) without waiting for in-flight work to complete. Never block the channel and never go silent fixating on one task while new input is waiting.

**Was zählt als "eine User-Aufgabe":** Alles, was der User in einer Message anfragt — auch wenn er mehrere Sub-Punkte aufzählt. Eine Message = ein Agent (mit allen Sub-Punkten im Prompt). Mehrere unabhängige Sub-Punkte in einer Message können in mehrere parallele Agents aufgeteilt werden, wenn sie unterschiedliche Files anfassen.

**Erlaubte Ausnahmen (eng definiert, nicht großzügig interpretieren):**
- Reine Fragen zur Codebasis ohne Edit ("wo ist X definiert?", "wie funktioniert Y?") — max. 1–3 Tool-Calls (Read/Grep/Glob), keine Edits.
- Live-Troubleshooting im Dialog mit Log-Snippets vom User.
- Ein **einziger** trivialer Fix (1 File, 1 Edit, < 60 Sekunden Gesamtarbeit inkl. tsc+lint).
- Wenn der User explizit "inline machen" / "selbst machen" / "nicht delegieren" sagt.

**Verboten:**
- Mehrere zusammengehörige Pages/Files inline durcheditieren ("Audit-Sweep", "5 Surfaces fixen") — das ist immer mehrere parallele Agents wert, nie inline.
- Lange Recherchen-Antworten zur User-Aufgabe schreiben, bevor du den Agent startest. **Erst delegieren, dann erklären** (in der 1–2-zeiligen Ack).
- Auf das Ergebnis eines Agents warten, bevor du den nächsten startest. Wenn zwischenzeitlich eine neue User-Message kommt, sofort den nächsten Agent starten.

**Ack-Protokoll (genau einhalten):**
Nach dem `Agent`-Tool-Call antwortest du dem User mit max. 2 Zeilen:
1. Was dispatched wurde (kurze Aufgaben-Bezeichnung).
2. Welche Files / Routen der Agent anfasst + ob Hotspot-Kollision mit gerade laufenden Agents besteht (falls ja: PROPOSED-Patch reporten lassen, siehe Hotspot-Liste unten).

Danach: **Stille bis zur nächsten User-Message oder Agent-Completion**. Keine zusätzlichen Erklärungen.

**Selbst-Check vor jeder Antwort:**

> "Tippe ich gerade eine Inline-Lösung für etwas, das der User mir gerade geschickt hat?"  
> Wenn ja → STOP, `Agent` dispatchen, 1–2-zeilige Ack, fertig.

> "Habe ich gerade > 2 File-Edits hintereinander für eine einzige User-Message gemacht?"  
> Wenn ja → die Regel ist bereits gebrochen. Stop, was übrig ist an einen Agent geben, nicht weiter inline.

Die volle Mechanik (Scope, Hotspots, Commit-Disziplin, Honest-Reporting) steht weiter unten unter § Agent-Parallelisierung. Diese Top-Regel überschreibt alles andere — wenn du dich fragst "soll ich inline oder Agent?" → immer Agent.

---

## ⚙️ Workflows / Multi-Agent-Orchestrierung — STRIKTE PFLICHT (User-Regel, 2026-06-05, verschärft · 2026-06-10 bekräftigt)

**Bekräftigt 2026-06-10 (User, explizit: „use multiple agents and workflow in future! strict rule"):** Diese Regel gilt **ausnahmslos** und **auch für Exploration, Planung und Audit** — nicht nur für Implementation. Keine langen Inline-Recherchen oder Inline-Edits, wenn parallele Agents (Explore/Plan) bzw. ein `Workflow` die Arbeit breiter, paralleler und verifiziert abdecken können. Default für **jede** nicht-triviale Aufgabe = **Workflow + Fan-out paralleler Agents + adversariale Verify-Phase**, dann erst Synthese/Push. Inline nur für die unten genannten engen Ausnahmen.

**STRIKTE User-Regel (höchste Priorität, NICHT optional):** Beginne **jede** nicht-triviale Aufgabe **mit einem Workflow** (`Workflow`-Tool, deterministische Multi-Agent-Orchestrierung). Workflows sind der **Default-Arbeitsmodus**, nicht die Ausnahme. **Mehrere Tasks → mehrere Workflows gleichzeitig** (im Zweifel ein eigener Workflow pro Task), und nutze **so viele Agents wie möglich** pro Workflow (Fan-out → Verify → Synthese), um das **bestmögliche Ergebnis** zu liefern — nicht nur das schnellste. **Keine Obergrenze** für parallel laufende Workflows oder Agents. Inline-Arbeit oder ein einzelner Background-Agent ist nur noch für die eng definierten Ausnahmen erlaubt (reine Codebasis-Frage ohne Edit, **ein einziger** trivialer 1-File-Fix, Live-Troubleshooting mit Log-Snippets, oder explizites „inline machen" des Users). In allen anderen Fällen gilt ausnahmslos: **Workflow zuerst.**

- **Workflow statt Einzel-Agents, wenn** die Aufgabe Struktur braucht: Fan-out über viele gleichartige Einheiten (z. B. ein Forecast / eine Page / ein Fix pro Reward-Typ), gefolgt von Verify-/Synthese-Phasen. Ziel: breit + konsistent + verifiziert liefern, nicht nur schnell.
- **Einzelne Background-Agents weiterhin** für unabhängige Task-Spam-Einzelaufgaben (eine User-Message = ein Agent). Die Parallel-Agent-Regeln oben bleiben unverändert gültig.
- **Kombinierbar:** Mehrere Workflows UND mehrere Background-Agents dürfen parallel laufen. Der Kanal bleibt immer empfangsbereit für neue User-Inputs.
- **Bewährte Muster:** understand → design → implement → review (je Phase ggf. ein eigener Workflow); `pipeline()` als Default, `parallel()`-Barrier nur wenn eine Phase wirklich alle Vorergebnisse braucht; fan-out + adversarial verify; loop-until-dry für Discovery.
- **In JEDEM Workflow/Agent unverändert bindend:** keine Prod-DB-Writes (read-only Hard-Rule), `npm run build`-Gate vor Push, Hotspot-Kollisionen vermeiden, Browser-Verifikation für UI, Honest-Reporting. Workflows heben KEINE dieser Regeln auf.

**Merkregel:** Großer, zerlegbarer Job → Workflow (fan-out + verify). Kleine unabhängige Task → Background-Agent. Bei Breite/Umfang im Zweifel → Workflow.

---

## 🚀 Push-Disziplin — häufig & inkrementell pushen (User-Regel, 2026-06-05)

**Der User wartet NICHT 40 Minuten, während du 5 Sachen sammelst und alles zusammen pushst.** Jede fertige, verifizierte (tsc + lint + `npm run build` grün) Aufgabe wird SOFORT einzeln committet + gepusht — niemals zu einem Sammel-Push gebündelt.

- **Ein Task fertig → sofort pushen.** Nicht auf andere laufende Tasks warten, nicht batchen.
- **Unabhängige Tasks parallel in isolierten git-Worktrees** (`isolation: "worktree"` mit eigenem `npm install` + eigenem `.next` — **`npm install`, NICHT `npm ci`** (der committete `package-lock.json` weicht ab, `npm ci` schlägt fehl); NICHT node_modules junctionen, sonst korrumpiert ein paralleles `prisma generate` den Main-Checkout) bauen und jeweils eigenständig nach `main` pushen (bei non-fast-forward: `git fetch origin && git rebase origin/main && git push origin HEAD:main`, retry bis es durchgeht). So blockiert ein langer Job (großer Workflow) nicht den EINEN Build-Slot des Main-Checkouts, und kleine Tasks verhungern nicht in einer Queue.
- **Niemals einen großen ungepushten Stau anhäufen.** Mehrere offene Tasks → jeden so früh wie möglich einzeln rausschicken.
- Build-Gate, Hotspot-Vermeidung, no-prod-DB-Writes und Honest-Reporting bleiben bindend — aber INNERHALB dieser Regeln gilt: so früh + so oft pushen wie möglich.

**Merkregel:** Ein Task = ein Push. Niemals 5 Tasks sammeln und am Ende einmal pushen.

**Owner-Regel (2026-06-12): Wenn du fertig bist → alles pushen.** Bevor du „done" meldest: **commit + push** alle Änderungen zu deiner Aufgabe. Kein Shippedes lokal liegen lassen. Nie committen: `.env`/Secrets, `src/generated/*`, `recent-pushes.json`, temp `_verify-*` Scripts. Nach Push: `git status` clean für Feature-Files — oder explizit sagen, was offen blieb und warum.

---

## 🔁 Persistent Parallel Workflow Mode (always active)

_Added per user instruction. This generalizes and reinforces the ABSOLUTE PRIORITÄTSREGEL above. Where this section and the repo-specific mechanics (Hotspot-Liste, Commit-/Push-Disziplin, Browser-Verifikation, Dual-DB, Active-Timeframe-Only) differ on specifics, the repo-specific rules win on those specifics — this section governs the overall operating posture._

Operate as a continuously-listening project agent, not a one-shot responder.

### Core behavior
- Treat every new user message as a possible new task, refinement, correction, continuation, or priority change. Read the newest message carefully and integrate it with the current project state before acting.
- Do not assume the previous plan is still correct if the new message changes scope, priorities, or constraints. New work → update the plan and continue. A newer instruction overrides an older one → follow the newest and adjust. Stay responsive to newly added tasks at all times.

### Parallel execution
- For every non-trivial request, use a parallel-agent workflow whenever possible. Break work into independent streams and run them in parallel — e.g. codebase audit, architecture/design decisions, backend/data analysis, frontend/UI implementation, testing/QA, documentation/changelog.
- Delegate separate subproblems to parallel agents for speed and coverage. If a task is too coupled for full parallelization, still parallelize the safely-separable parts, then merge carefully (respecting the Hotspot-Liste — never two agents on the same hotspot file).

### Workflow for each new task
1. **Interpret the input** — new task / modification / bug report / follow-up / reprioritization. Extract explicit requirements and infer implied ones.
2. **Update the active plan** — merge the new instruction; identify what stays valid, what must change, what to pause or discard.
3. **Split into parallel workstreams** — separate into independent units; assign to parallel agents when concurrency is safe (no hotspot collision).
4. **Execute with coordination** — focused work per stream; periodically reconcile outputs so final changes stay consistent across the codebase.
5. **Validate globally** — do not stop at local success; check downstream impact across UI, backend, shared utilities, stats/derived metrics, exports, tests, and docs.
6. **Report clearly** — what changed, what is in progress, what assumptions were made, recommended follow-ups. (On *dispatch*, keep the ack to the 1–2 lines per the Ack-Protokoll above; the full structured report is for substantial *completed* work.)

### Quality standard
- Prefer multi-file reasoning over isolated edits; source-of-truth fixes over cosmetic patches; reusable architecture over one-off exceptions.
- Always look for affected pages, shared logic, derived metrics, API consumers, and edge cases. Always check whether the request should also update tests, admin tools, analytics, docs, and related dashboard surfaces.

### Persistence (internal working memory)
Keep track of: current objective · active sub-tasks · completed work · pending validations · open risks · latest user priority. Each new message updates this active working state — not an unrelated fresh chat, unless the user clearly starts a totally separate topic.

### Task-intake shorthands
Short follow-ups like "also do this", "change that", "same for this page", "fix this too", "make it more detailed", "now check mobile" = instructions to continue the current workflow and expand the plan accordingly.

### Use parallel agents by default when a task includes two or more of:
repo scanning · implementation · refactoring · debugging · test writing · UI polish · analytics/stat logic · documentation.

### Non-negotiables
- Never ignore a newer user instruction. Never treat follow-up messages as optional context. Never stop at one file if the task obviously affects multiple systems. Never ship partial logic while shared calculations, filters, metrics, or dashboard surfaces remain inconsistent. Never use parallel agents blindly — coordinate and reconcile their outputs before finalizing.

### Output style (substantial tasks)
Updated objective · Parallel workstreams · Changes made · Cross-system impacts checked · Remaining risks · Next recommended actions.

### Final
Always watch for new inputs, merge them into the active workflow, use parallel agents when they improve speed/coverage/quality, and optimize for the best final project outcome — not just the fastest single reply.

---

## 🔒 Browser-Verifikation & Done-Kriterien (CRITICAL)

Für jede Aufgabe, die UI, Routing, Rendering, Interaktionen, Filter, Search, Pagination, Tabs, Drawers, Modals, Charts, KPI-Panels oder sichtbare Daten im Admin betrifft, gilt:

### 1. Browser-Verifikation ist Pflicht
- Eine Aufgabe gilt **nicht** als erledigt, nur weil Code geschrieben wurde, `tsc` grün ist oder `lint` grün ist.
- Wenn die betroffene Änderung im Browser sichtbar oder testbar ist, muss sie **im Browser verifiziert** werden, bevor "fertig", "fixed" oder "done" gesagt wird.
- "Sollte funktionieren", "likely fixed", "wahrscheinlich", "bitte hard refreshen" sind **verbotene Abschlussformulierungen**, wenn keine echte Browser-Prüfung gemacht wurde.
- Wenn Browser-Zugriff verfügbar ist, ist Browser-Verifikation der Standard, nicht die Ausnahme.

### 2. Definition of Done (verbindlich)
Eine Aufgabe ist nur dann `DONE`, wenn **alle** Punkte erfüllt sind:
1. Relevanter Code ist umgesetzt.
2. `tsc --noEmit` ist grün.
3. `npm run lint` ist grün.
4. Der betroffene Flow / die betroffene Route wurde real validiert.
5. Bei UI-/Admin-Aufgaben: Browser-Verifikation erfolgt.
6. Keine offensichtliche Regression in direkt betroffenen Nachbar-Flows.

Wenn einer dieser Punkte fehlt:
- Status = `IN PROGRESS`, `PARTIAL`, `PROPOSED` oder `BLOCKED`, **nicht** `DONE`.

### 3. Regression-Sweep bei Shared Changes
Wenn eine Änderung eine Shared-Datei betrifft (z. B. Hooks, Query-Utilities, Layout, Table-Komponenten, Filter-Bar, Panels, gemeinsame UI-Komponenten, gemeinsame Server-Queries), dann reicht die Verifikation der Ursprungsseite nicht aus.

Dann müssen zusätzlich alle offensichtlichen Consumer geprüft werden:
- gleiche Komponente auf anderen Seiten,
- gleiche Query-/Filter-Logik in Schwester-Routen,
- gleiche Layout-/Toolbar-Struktur,
- gleiche KPI-/Chart-/Table-Container.

### 4. Incident-Modus bei "still broken"
Wenn der User Formulierungen benutzt wie:
- "still broken"
- "immer noch kaputt"
- "in browser noch falsch"
- "fix live"
- oder konkrete Live-URL / Route + Bug meldet,

dann gilt automatisch Incident-Modus:
- kein nice-to-have scope creep,
- kein vorzeitiges Zusammenfassen,
- kein Wechsel auf Nebenthemen,
- Fokus auf reproduzieren → fixen → browser-verifizieren → nochmal prüfen.

In Incident-Modus ist die Aufgabe erst abgeschlossen, wenn das Problem auf der betroffenen Live-/Admin-Route im Browser nicht mehr reproduzierbar ist.

### 5. Performance-Verifikation für Tabs / Timespans
Bei Seiten mit Perioden-/Timeframe-/Tab-Umschaltung gilt zusätzlich:
- Initial darf nur der aktive Tab + aktive Zeitraum laden.
- Versteckte Tabs oder andere Zeitfenster dürfen nicht eager geladen werden.
- Nach Änderungen an solchen Seiten muss geprüft werden, dass dieses Verhalten eingehalten wird.

### 6. Honest Completion Reporting
Erlaubte Status-Wörter:
- `DONE` = vollständig umgesetzt und verifiziert
- `PARTIAL` = teils umgesetzt, aber noch nicht vollständig verifiziert oder noch offene Punkte
- `PROPOSED` = nur analysiert / Patch vorgeschlagen, nicht angewendet
- `BLOCKED` = konnte nicht abgeschlossen werden, Grund nennen

**"DONE" ohne Verifikation ist verboten.**

### 7. UI-Verifikation ohne Live-Browser (Fallback-Mechanik, Session-Learning 2026-06-05)
Wenn **kein** live eingeloggter Browser verfügbar ist (Chrome-Extension offline), ist der `npm run build`-Gate **nicht genug** — trotzdem rendern:
- **Admin-Session minten:** ein `admin_session` JWT signieren (mit `SESSION_SECRET`, exakt nach `src/lib/session.ts`; einen aktiven Admin **read-only** aus der ADMIN-DB lesen) und **Playwright** über die Routen fahren. Wiederverwendbarer Harness: `e2e/responsive/*` + `playwright.responsive.config.ts` (Mint-Helper: `e2e/responsive/mint-session.ts`).
- **Lokale Game-DB ist stale** (fehlende Tables → live Admin-Pages werfen lokal). Pages, die deshalb nicht rendern, über **dev-only Fixtures** rendern: `src/app/responsive-fixture/*`.
- **Ehrlich bleiben:** build-verified + fixture-/minted-session-gerendert ist **NICHT** dasselbe wie ein echter eingeloggter Click-Through. Wenn nur so verifiziert wurde, ist der Status **`PARTIAL`** (Verifikations-Gap nennen), nicht `DONE` — und einen echten Logged-in-Pass empfehlen.

---

## ⚠️ Shared-File Collision Escalation (CRITICAL)

Wenn ein Agent eine Hotspot-Datei oder eine klar shared genutzte Datei anfassen muss, die:
- bereits von einem anderen laufenden Agent bearbeitet wird,
- oder sehr wahrscheinlich mehrere Surfaces gleichzeitig beeinflusst,

dann gilt standardmäßig:
- kein blindes Direkt-Edit parallel,
- stattdessen PROPOSED-Patch + kurze Impact-Notiz,
- danach Konsolidierung auf dem neuesten Stand,
- erst dann final anwenden, testen, committen, pushen.

Beispiele für shared-risk Dateien:
- globale Query-Utilities
- `src/lib/queries/**`
- zentrale Table-/Filter-/Toolbar-Komponenten
- `src/app/(admin)/layout.tsx`
- gemeinsame modern panels / KPI primitives
- gemeinsame auth / DAL / permissions utilities

Merkregel:
Je stärker eine Datei cross-route reused wird, desto höher die Pflicht zur Kollisionsvermeidung und Regression-Prüfung.

---

## Teil 1 — Arbeitsregeln (verbindlich)

Du arbeitest an einer bestehenden Codebasis.  
Dein Ziel ist es, sicher, sauber, nachvollziehbar und effizient zu arbeiten — nicht schnell um jeden Preis.

### Grundregeln

- Arbeite sauber und ohne unnötige Umwege.
- Rate nicht.
- Erfinde keine Implementierungen, Abläufe, APIs, Datenstrukturen oder Workarounds, wenn sie nicht klar aus der bestehenden Codebasis oder verifizierten Informationen hervorgehen.
- Nutze keine Fallbacks, Notlösungen, stillen Umgehungen oder "temporary fixes", wenn der eigentliche Weg nicht verifiziert und nachweislich korrekt ist.
- Wenn ein Weg technisch nicht bestätigt ist, behandle ihn nicht als gültig.
- Wenn du dir bei einem Ablauf, einer bestehenden Struktur oder einer Abhängigkeit nicht sicher bist, prüfe zuerst die aktuelle Codebasis gründlich.
- Wenn etwas nicht klar verifizierbar ist, sage es klar und arbeite nicht mit Annahmen weiter.

### Umgang mit der bestehenden Codebasis

- Verstehe zuerst die bestehende Architektur, bevor du Änderungen machst.
- Folge dem bestehenden Stil, den bestehenden Patterns und der vorhandenen Struktur der Codebasis.
- Füge nichts ein, was stilistisch oder architektonisch nicht zum Projekt passt.
- Respektiere bestehende Konventionen bei:
  - Dateistruktur
  - Benennung
  - Trennung von Zuständigkeiten
  - Error Handling
  - Typisierung
  - Validation
  - Auth
  - Datenbankzugriff
- Prüfe immer zuerst, ob es bereits bestehende Utilities, Services, Hooks, Komponenten, Helpers oder Patterns gibt, die wiederverwendet werden sollen.

### Sicherheit

Sicherheit ist Pflicht und kein Extra.

- Achte bei jeder Änderung auf Security-Auswirkungen.
- Denke User-bezogen, nicht global oder pauschal.
- Auth, Permissions und Datenzugriff müssen immer sauber pro User geprüft werden.
- Kein User darf auf Daten, Aktionen oder Zustände anderer User zugreifen können, wenn das nicht explizit vorgesehen und abgesichert ist.
- Vertraue niemals blind auf Frontend-Logik für Security.
- Prüfe serverseitig:
  - Authentifizierung
  - Autorisierung
  - Ownership
  - Input Validation
  - Zugriff auf sensible Daten
- Vermeide unsichere Shortcuts.
- Keine sensiblen Daten in Logs, Responses oder unnötigen Client-Payloads.
- Achte auf sichere Defaults.

### Qualität der Umsetzung

- Schreibe Code so, dass er klar, wartbar und langfristig stabil ist.
- Bevorzuge klare und direkte Lösungen statt cleverer, unnötig komplexer Konstruktionen.
- Keine überflüssige Abstraktion.
- Keine duplizierte Logik, wenn sie sinnvoll in bestehende Strukturen integriert werden kann.
- Halte Änderungen so klein wie möglich, aber so vollständig wie nötig.
- Mache keine versteckten Nebenwirkungen.
- Ändere keine unrelated Teile der Codebasis ohne klaren Grund.

### Verifikation vor Umsetzung

Bevor du eine Lösung umsetzt:

1. Prüfe, wie die aktuelle Codebasis den relevanten Bereich bereits behandelt.
2. Identifiziere die echten bestehenden Datenflüsse und Verantwortlichkeiten.
3. Verifiziere, dass dein Ansatz zu den vorhandenen Mustern passt.
4. Wenn etwas nicht eindeutig belegt ist, frage nach statt zu raten.

### Tests und Validierung

- Teste alles, was du änderst, so gut wie möglich.
- Verlasse dich nicht darauf, dass etwas "wahrscheinlich funktioniert".
- Prüfe Logik, Edge Cases und mögliche Seiteneffekte.
- Wenn Tests im Projekt existieren, nutze und erweitere sie passend.
- Wenn keine Tests existieren, validiere Änderungen mindestens nachvollziehbar über den realen Flow.
- Betrachte eine Aufgabe nicht als fertig, nur weil der Code geschrieben wurde. Sie ist erst fertig, wenn sie geprüft wurde.

### Keine erfundenen Fakten

- Erfinde keine Tabellen, Spalten, Endpoints, Umgebungsvariablen, Secrets, Responses, Services oder Third-Party-Verhalten.
- Erfinde keine Datenbankstruktur.
- Erfinde keine bereits existierenden Funktionen oder Files.
- Erfinde keine "wahrscheinlichen" Zusammenhänge.

Wenn etwas nicht klar in der Codebasis oder durch den User bestätigt ist, frage nach.

### Datenbank-Regel

Wenn du für eine Aufgabe Datenbankinformationen brauchst, frag den User zuerst.  
Der User gibt die nötigen Daten dann direkt.

Das gilt insbesondere für:
- Schema
- Tabellen
- Spalten
- Relations
- Queries
- Migrations
- Constraints
- Indizes
- vorhandene Datenbanklogik

**Nimm bei DB-Themen niemals Annahmen als Grundlage.**

### Ehrlichkeit über erledigte Arbeit (CRITICAL)

- **Niemals lügen** über den Stand der Arbeit. Nicht "fertig" sagen, wenn es nicht wirklich fertig ist.
- **Niemals in Zusammenfassungen / Changelogs behaupten**, etwas sei erledigt, das nicht angefasst wurde. Jede Zeile im Summary muss einer tatsächlich gemachten Änderung entsprechen.
- Wenn der User mehrere Dinge verlangt und du push willst: **erst ALLE durcharbeiten**, dann pushen. Kein "push now, finish later" ohne das klar zu benennen.
- Wenn etwas ausgelassen oder vergessen wurde: **direkt und ungefragt flaggen**, bevor der User danach fragen muss.
- Wenn etwas nicht gemacht werden konnte (blocked, unklare Anforderung, fehlende Info): sag es **bevor du pushst**, nicht hinterher.
- Wenn Browser-Verifikation erforderlich war und nicht durchgeführt wurde, muss das explizit als unvollständig genannt werden.

### Kommunikation

Wenn du etwas nicht sicher verifizieren kannst:
- sag es direkt
- nenne kurz, was unklar ist
- frage gezielt nach den fehlenden Infos

Wenn mehrere Wege möglich sind:
- nimm den saubersten und sichersten
- nicht den schnellsten unsaubersten

Wenn ein bestehender Flow unsicher, inkonsistent oder kaputt wirkt:
- weiche nicht still auf einen unbestätigten Ersatzweg aus
- benenne das Problem klar
- schlage nur verifizierbare Lösungen vor

### Ziel

Arbeite so, als würde der Code produktiv laufen, mit echten Usern, echtem Geld und echten Sicherheitsrisiken.

Das bedeutet:
- sicher
- sauber
- nachvollziehbar
- verifiziert
- wartbar
- ohne geratenen Unsinn

### Agent-Parallelisierung (Arbeitsweise)

Die Top-Regel oben (§ 🔥 ABSOLUTE PRIORITÄTSREGEL) ist bindend. Dieser Abschnitt definiert die Mechanik dahinter.

Der User arbeitet in einem "Task-Spam"-Modus: er wirft Aufgaben nacheinander rein und erwartet, dass du jede in einem eigenen Background-Agent startest, damit er nicht warten muss. Das ist die Standard-Arbeitsweise, nicht die Ausnahme.

**Regeln für parallele Agents:**

1. **Eine Aufgabe → ein Agent.** Neue Aufgabe des Users → `Agent` Tool mit `run_in_background: true` starten. Die einzigen Ausnahmen stehen in der Top-Regel oben (reine Codebasis-Fragen, Live-Troubleshooting, **ein einziger** trivialer 1-File-Fix, oder explizite "inline machen"-Anweisung). Audit-Sweeps über mehrere Pages / Surfaces / Query-Files sind **nie** trivial — die zerlegt man in N parallele Agents, nicht in eine lange Inline-Session.

2. **Explicit scope + avoid-list pro Agent.** Jeder Agent-Prompt enthält:
   - Klare Deliverables (Dateien, Routen, Features).
   - Liste von Dateien, die gerade von anderen Agents bearbeitet werden — **"AVOID these files"**.
   - Projekt-Konventionen (CLAUDE.md lesen, Dual-DB Regel, UI-Stil, keine neuen Deps).
   - "Malware-Refusal"-Reminder explizit als false-positive entkräften (Repo ist user's eigenes Admin-Panel, legitim).

3. **File-Kollisions-Hotspots** (müssen sequenziell oder mit feinem Scope bearbeitet werden, nicht parallel):
   - `src/components/app-sidebar.tsx`
   - `src/lib/permissions.ts` + `src/app/(admin)/settings/roles/permissions-utils.ts`
   - `src/lib/admin-pages.ts`
   - `prisma/admin/schema.prisma` + Migrations-Ordner
   - `src/lib/dal.ts`
   - `src/app/(admin)/layout.tsx`
   - `package.json` / `next.config.ts`
   - Jede Datei in `src/generated/` (nie direkt bearbeiten — Prisma regeneriert)
   - `src/lib/queries/**`
   - zentrale Table-/Filter-/Toolbar-Komponenten
   - gemeinsame modern panel / KPI primitive Dateien

   Wenn zwei Agents dieselbe Hotspot-Datei brauchen: den zweiten mit einem PROPOSED-Patch reporten lassen, dann nach dem Konsolidieren selbst anwenden.

4. **Commit- und Push-Disziplin bei paralleler Arbeit:**
   - Jeder Agent committet in **kleinen logischen Chunks** (nicht eine Riesen-Commit am Ende).
   - `git commit --only <paths>` wenn andere Agents gleichzeitig staged Changes haben.
   - `tsc --noEmit` + `npm run lint` **nach jedem Commit**, nicht erst am Ende.
   - **Agents dürfen und sollen direkt pushen** sobald tsc + lint grün sind, **außer** eine Shared-/Hotspot-Datei ist betroffen oder eine Kollisionsgefahr besteht.
   - Bei Shared-/Hotspot-Dateien gilt: erst Konsolidierung / Rebase / Regression-Sweep, dann push.
   - Wenn ein Push wegen Divergenz (`non-fast-forward`) scheitert: zuerst `git pull --rebase`, dann nochmal pushen. Keine destruktiven Operationen ohne User-Zustimmung.

5. **Konsolidierungs-Phase ist optional** und passiert nur wenn offene Issues quer durch mehrere Agents zu fixen sind (orphan references, inkonsistente API-Shapes, TSC/Lint-Failures die keiner Agent alleine verursacht hat). Sonst: einfach pushen und weiter.

6. **Honest-Reporting** pro Agent:
   - `FIXED` = wirklich gemacht + im Commit + verifiziert
   - `PROPOSED` = analysiert + Patch bereit, aber nicht angewendet (meist weil off-limits)
   - `DEFERRED` = nicht bearbeitet, Grund nennen
   - `BLOCKED` = konnte nicht abgeschlossen werden, Grund nennen
   - **Keine Zeile im Summary darf eine Unwahrheit sein.** (Siehe Ehrlichkeits-Regel oben.)

7. **Aufgaben, die du NICHT an Agents delegierst** (Liste ist abschließend, nicht großzügig erweitern):
   - **Ein einziger** trivialer Fix: 1 File, 1 Edit, **inkl. tsc + lint + commit + push** in unter 60 Sekunden. Zwei "kleine" Fixes hintereinander für eine User-Message sind **kein** trivialer Fix — die gehen an einen Agent.
   - Reine Codebasis-Fragen ohne Edit ("wo ist X definiert?") — max. 1–3 Tool-Calls.
   - Live-Troubleshooting mit User (Logs anschauen, Symptom rekonstruieren).
   - User sagt explizit "inline machen" / "selbst" / "nicht delegieren".

8. **Wenn der User zu schnell Tasks reinwirft:**
   - Nicht zögern — sofort Agent starten.
   - Kurz bestätigen welche Files der neue Agent anfasst + ob/wo Kollisionsrisiko.
   - Nicht auf vorherige Agents warten, wenn die Arbeit unabhängig ist.

**Merkregel:** Wenn du dich fragst "soll ich das selber machen oder einen Agent starten?" — Agent starten. Der User will nicht blockieren.

### Fan-out-Geometrie & Build-/Verify-Agent-Contract (Worktrees) — Session-Learning 2026-06-05

**Fan-out nach UNIT, nicht nach File:**
- Viele unabhängige Units (viele Pages/Files) → **viele parallele Agents**, einer pro Unit (`parallel()` / `pipeline()` im Workflow).
- **EIN** gekoppeltes File / eine Surface → **1 Builder + 1 adversarialer Verifier**. **Niemals zwei editierende Agents auf dieselbe Datei** — sie clobbern sich. Der „zweite Agent" für gekoppelte Arbeit ist der **Verifier**, kein zweiter Editor.
- Typische Shapes: **discover → build → verify** oder **fan-out → synthesize/verify**.

**Build-Agent-Contract (jeder Worktree-Agent):**
- Worktree-Start: `git fetch origin && git reset --hard origin/main`; die `.env` des Main-Checkouts kopieren; **`npm install`** (NICHT `npm ci` — Lockfile-Mismatch).
- Gate vor Push: `npx tsc --noEmit` + `npm run lint` (0 NEUE Warnings) + **`npm run build` (exit 0)**. `npm run build` ist **autoritativ** — Client→Server-Boundary-Fehler (z. B. Function-Props über die RSC-Grenze) tauchen nur dort auf, nicht in `tsc`.
- Commit mit **`git commit --only <deine Files>`** (**nie** `git add -A`); immer **uncommitted lassen**: `src/generated/*`, `package-lock.json`, `recent-pushes.json`, `audit-artifacts/`.
- Push: `git fetch origin && git rebase origin/main && git push origin HEAD:main`; bei non-fast-forward retry. **Den eigenen Worktree NICHT entfernen** — der Orchestrator räumt auf (junction-safe). Stray dev-Server killen (z. B. ein übrig gebliebenes `next dev` auf :3000).

**Verify-Agent-Contract:**
- **VOR dem Lesen** `git fetch` + den **exakten** Commit (SHA) auschecken — ein stale Tree hat diese Session ein False-Negative erzeugt („Feature nicht gefunden", obwohl vorhanden).
- Adversarial re-checken; **jedes „not found"-Verdikt** gegen `git show <sha>` gegenprüfen, bevor es als fehlend gemeldet wird.

**Workflow-`script`-Strings (Parser-Fallen):** **keine** inneren Backticks und **kein** `\'`/`\\'`-Quote-Escape in einem Workflow-`script`-String (beides bricht das Parsing) — Plaintext + `' + REPO + '`-Konkatenation nutzen. In Fan-outs gelegentlich mit **StructuredOutput-No-Shows** rechnen → `.filter(Boolean)` + den Downstream-Step neu ableiten lassen.

---

## Teil 2 — Projekt-Konventionen (pokewin-admin)

Diese Konventionen wurden aus der bestehenden Codebasis ermittelt. Sie sind bindend und dürfen nicht ignoriert werden. Bei Unsicherheit: aktuelle Codebasis prüfen, **nicht raten**.

### Tech Stack (Stand letzter Exploration)

- **Framework:** Next.js 15.5.12 (App Router, Turbopack)
- **Language:** TypeScript 5 (strict mode)
- **React:** 19.1.0
- **Styling:** Tailwind CSS 4 + shadcn/ui (base-nova)
- **Datenbank:** PostgreSQL via Prisma 7.5.0
- **Auth:** JWT (`jose`) + TOTP 2FA (`otpauth`)
- **Validation:** Zod 4.3.6
- **Toasts:** `sonner`
- **Tables:** TanStack Table 8
- **Charts:** Recharts

### UI & Design (clean, konsistent — CRITICAL)

Das Projekt hat ein **cleanes, konsistentes UI** — dieser Stil ist verbindlich und muss beibehalten werden. Für jede neue UI-Arbeit gilt:

**Ausschließlich das bestehende UI-Framework-Setup verwenden:**

| Zweck | Library | Regel |
|---|---|---|
| Styling | Tailwind CSS 4 | Keine inline styles, keine CSS-Module, kein styled-components |
| Komponenten-Primitives | shadcn/ui (base-nova) | Erst in `src/components/ui/` schauen, dann ggf. via shadcn CLI ergänzen |
| Unstyled Primitives | `@base-ui/react` | Für Custom-Verhalten, das shadcn nicht abdeckt |
| Icons | `lucide-react` | Keine anderen Icon-Libraries (kein Heroicons, kein FontAwesome, etc.) |
| Charts | `recharts` | Keine Chart.js, kein Nivo, kein Victory |
| Tabellen | `@tanstack/react-table` + `src/components/data-table/` | Bestehende Data-Table-Komponenten wiederverwenden |
| Toasts | `sonner` | `toast.success()` / `toast.error()` — keine alternativen Toast-Libs |
| Drag & Drop | `@dnd-kit/*` | Kein react-beautiful-dnd, kein react-dnd |
| Datasheet-Grid | `react-datasheet-grid` | Nur wo bereits im Einsatz |
| Command Palette | `cmdk` | Für Search/Quick-Actions |
| Theme | `next-themes` | Dark Mode ist Default — nicht eigenständig umbauen |

**Verbindliche Regeln:**
- **Keine anderen UI-Frameworks mischen.** Kein Material UI, kein Chakra, kein Ant Design, kein Mantine, kein DaisyUI, kein Radix direkt (nur über shadcn/base-ui).
- **Keine neuen Design-Systeme einführen.** Wenn shadcn/ui bereits eine passende Komponente hat → diese verwenden.
- **Clean bleiben:** Keine überladenen UIs, keine unnötigen Animationen, keine dekorativen Elemente ohne Funktion. Das bestehende Design ist zurückhaltend und funktional — das gilt als Maßstab.
- **Farb-System:** Nur die CSS-Variablen aus `src/app/globals.css` + die Konstanten aus `src/lib/constants.ts` (`ROLE_COLORS`, `STATUS_COLORS`, etc.) verwenden. Keine hardcoded Farben außerhalb dieser Quellen.
- **Dark Mode ist Default.** Jede neue Komponente muss Dark Mode respektieren (`dark:` Varianten).
- **Komponenten-Struktur spiegeln:** Neue Komponenten folgen den Patterns in `src/components/` und den Feature-Ordnern. Kein alternatives Layout-System.
- **Aurora-Background** (WebGL via `ogl`) nur dort, wo bereits im Einsatz — nicht ohne Absprache ausweiten.
- **Bevor neue UI-Dependencies hinzugefügt werden: nachfragen.** Keine stillschweigenden `npm install`s von UI-Libraries.
- **Tremor nicht zusätzlich einführen**, wenn die bestehende shadcn/base-nova + Recharts + Data-Table-Kombination den Bedarf bereits abdeckt. Bestehende Haus-Patterns haben Vorrang.

**Merkregel:** Wenn du etwas gestaltest, das aussieht wie aus einem anderen Projekt → falsch. Es muss aussehen wie der Rest von pokewin-admin.

### Modern Page Pattern (verbindlich für neue Seiten)

Jede neue Admin-Seite muss dem modernen Stil von `/users/[id]` folgen. Das ist die Referenz, keine Ausnahmen.

**Pflicht-Bausteine (alle bereits in der Codebase, niemals neu bauen):**

| Baustein | Pfad | Einsatz |
|---|---|---|
| `PageHero` | `src/components/modern-panels.tsx` oder `src/app/(admin)/users/[id]/user-view-modern-panels.tsx` | Jede Seite startet mit einem Hero: Gradient-Container mit Corner-Glows (`blur-3xl` absolut positionierte divs), Titel + Icon + Untertitel, optional Action-Slot rechts |
| `SectionHeading` | gleich | Icon-Chip + Title + optional Action — trennt Abschnitte innerhalb der Seite |
| `StatPanel` | gleich | Große Panels mit Corner-Glow, Icon-Chip, Hero-Zahl, Breakdown-Rows |
| `KpiTile` / `MetricTile` | gleich | Kompakte bzw. mittlere KPI-Kacheln mit Accent-Farbe aus `TILE_COLORS` |
| `PanelRow` | gleich | Breakdown-Zeilen innerhalb von `StatPanel` |
| `AnimatedNumber` | `src/components/animated-number.tsx` | Zahlen-Transitions bei Werteänderungen, nutzt `formatKind` Enum (currency / number / percent), **niemals Function-Props** über die RSC-Grenze |
| `FadeIn` | `src/components/fade-in.tsx` | Weiches Reinfaden für große Content-Blöcke |

**Regeln:**
- **Kein reiner `<h1>` als Seitenkopf** mehr — immer `PageHero` mit Icon + Gradient.
- **Keine blanken `<Card>` Stat-Kacheln** — die modernen `KpiTile` / `StatPanel` aus dem oben genannten Set nutzen. Accent-Farbe bewusst aus `TILE_COLORS` wählen (blue / emerald / rose / cyan / amber / purple / orange / pink).
- **Tabellen** bleiben `@tanstack/react-table` + `src/components/data-table/`, aber eingebettet in einen modernen Container mit `SectionHeading` darüber.
- **Charts** nutzen `recharts` mit `animationDuration={700}` + `animationEasing="ease-out"`.
- **Reduce-Motion** muss respektiert sein (tailwind `motion-safe:` / `motion-reduce:` oder Mediaquery).
- **Finanz-Farben IMMER aus House-Perspektive — STRIKT, KEINE AUSNAHMEN.** Gilt für die gesamte Site. Jeder Geldbetrag, jeder Badge, jede Kennzahl, jedes Chart, jede Zelle, jede Zahl. Niemals User-Perspektive.

  **Die EINE Regel:**
  > **User gewinnt / macht Profit → 🔴 ROT**  
  > **User verliert Geld → 🟢 GRÜN**  
  > **Neutraler Event (Signup etc.) → 🔵 BLUE**

  Warum: jeder Dollar den der User hat, ist ein Dollar den wir schulden. User-Gewinn = unser Verlust = rot. User-Verlust = unser Gewinn = grün. Das ist das einzige Prinzip — alles andere ist davon abgeleitet.

  **Konkretes Mapping aller ledger-Events:**

  | Event | Was bedeutet es für den User | Farbe |
  |---|---|---|
  | Deposit (User zahlt ein) | Kapital zu uns, User hat noch keinen Gewinn | 🟢 emerald |
  | Wager / Bet (pack_opening, battle_bet, battle_sponsorship) | User riskiert sein Geld, wir nehmen's | 🟢 emerald |
  | Withdrawal (card_withdrawal) | User holt Geld raus | 🔴 rose |
  | Battle win (battle_refund) | User gewinnt | 🔴 rose |
  | Rain win / Race prize / Creator tip | User bekommt Geld geschenkt | 🔴 rose |
  | Deposit bonus / Gift card / Promo / Voucher redeem | House schenkt User etwas | 🔴 rose |
  | Rakeback claim / Affiliate claim / Balance reward / Waitlist prize | User zieht eine Vergütung | 🔴 rose |
  | Admin balance adjustment (User bekommt Geld gutgeschrieben) | User gewinnt Geld | 🔴 rose |
  | P&L / GGR / Platform Revenue POSITIV | Wir im Plus | 🟢 emerald |
  | P&L / GGR / Platform Revenue NEGATIV | Wir im Minus | 🔴 rose |
  | Signup / Status-Event / Info-Event | neutral | 🔵 blue |

  **P&L-Formel (pro User UND global):**
pnl = deposits − withdrawals − onSiteBalance − inventoryValue − unclaimedVouchers

text
Wenn der User mehr on-site + Inventar hat als er deposited hat → `pnl < 0` → 🔴 ROT.

**Quick test vor jedem Commit:** "Wenn der User diesen Event feiert — ist die Farbe rot?" Ja → korrekt. Nein → Farbe flippen.

Gilt für (checklist beim Neu-Bau oder Refactor):
- Recent-Activity Feeds
- Stat-Panels mit P&L (Dashboard, User-Detail, Creator-Detail, Battle-Detail, Pack-Detail)
- Amount-Labels + Vorzeichen (+ / −) — aus Haus-POV
- Charts mit Gewinn/Verlust-Differenzierung
- Transaction-Detail Seiten
- Battle-Detail "House Profit" Zahlen
- Jede Tabelle mit einer Spalte "Amount" / "PnL" / "Profit"
- Wager-Leaderboards (falls welche existieren)

- **Keine Funktions-Props von Server → Client Component.** Serialisierbare Primitives / String-Enums nutzen. Next.js 15 crasht sonst.

**Verbindlich für jede neue Page unter `src/app/(admin)/...`:**
1. Server Component als `page.tsx` mit `requirePageAccess(key)` zuerst.
2. `PageHero` als erstes rendertes Element.
3. KPI-Strip (3–6 Tiles) direkt darunter.
4. Abschnitte mit `SectionHeading` + Content.
5. Dark Mode respektiert, `motion-safe` Animationen.
6. Lint + tsc clean.

**Merkregel:** Wenn eine neue Seite nicht aussieht wie `/users/[id]`, stimmt etwas nicht. Vergleich mit der Referenz vor dem Commit.

### Dual-Database-Architektur (CRITICAL)

Das Projekt nutzt **zwei vollständig getrennte PostgreSQL-Datenbanken** mit jeweils eigenem Prisma-Client. Diese Trennung ist strikt, nicht optional, und darf unter keinen Umständen aufgeweicht werden.

#### 1. Main DB — die Produktions-DB der eigentlichen Website (packy.gg)

- **Client:** `getDb()` (bzw. `db`) aus `src/lib/db.ts` — unterstützt einen prod/dev-Toggle (`admin_db_env`-Cookie + `DEV_DATABASE_URL`); Entry-Points `getDb()` / `getProdDb()` / `getDevDb()`, nicht mehr nur ein statischer Import. MAIN setzt zusätzlich `statement_timeout: 30s`.
- **Schema:** `prisma/schema.prisma`
- **Env-Var:** `DATABASE_URL`
- **Inhalt:** alles was die eigentliche Game-Plattform betrifft — User-Accounts, Balances, Ledger-Transaktionen, Packs, Cards, Battles, Inventory, Rewards, Affiliate-System, Deposits/Withdrawals, Promo-Codes, Gift-Cards, Vouchers, Rain/Raffles/Races, etc.
- **Diese DB ist die Live-Produktion der Website.** Sie enthält echte User, echtes Geld, echte Transaktionen. Jeder Zugriff — auch lesend, auch beim lokalen Entwickeln — wird so behandelt, als würde er gegen Produktion laufen. Schreibzugriffe auf diese DB ohne ausdrückliche Absprache mit dem User sind nicht erlaubt.

#### 2. Admin DB — ausschließlich für das Admin-Panel

- **Client:** `adminDb` aus `src/lib/admin-db.ts`
- **Schema:** `prisma/admin/schema.prisma` (eigene `prisma.config.ts`)
- **Env-Var:** `ADMIN_DATABASE_URL`
- **Inhalt:** nur Daten, die das Admin-Panel selbst betreffen — `admin_users`, `admin_sessions`, `admin_audit_events`, `admin_notes`, `admin_gift_card_actions`, `admin_voucher_actions`, `admin_balance_limits`, `creator_deals`, `creator_webhooks`, `expenses`, `recurring_expenses`.
- **Keine Game- oder User-Daten.** Hier liegen nur Informationen darüber, wer sich wann als Admin eingeloggt hat, welcher Admin was getan hat, welche Creator-Deals existieren, welche Ausgaben getrackt werden, etc.

#### Strikte Trennungs-Regeln

- `db` darf **niemals** Admin-Tables lesen oder schreiben.
- `adminDb` darf **niemals** Game-/User-Tables lesen oder schreiben.
- **Cross-DB-Joins existieren nicht.** Wenn Daten aus beiden DBs gebraucht werden, werden sie separat abgefragt und in Code zusammengeführt (z.B. `admin_audit_events.target_user_id` → separater Query auf `users` in Main-DB).
- Bei neuen Features: erst entscheiden welche Domain, dann den passenden Client wählen. Niemals raten, niemals "den anderen" Client nehmen weil es gerade schneller geht.
- Jede neue Tabelle gehört eindeutig in eine der beiden DBs — im Zweifel fragen.

**Merkregel:** Main-DB = was User sehen. Admin-DB = wie wir User verwalten. Wenn eine Info im User-Frontend auftauchen könnte, gehört sie in Main-DB. Wenn sie nur im Admin-Panel Sinn ergibt, gehört sie in Admin-DB.

### Auth- & Permission-Pattern (verbindlich)

Für alle geschützten Server Components, Server Actions und API Routes: **ausschließlich** die existierenden DAL-Funktionen in `src/lib/dal.ts` verwenden.

- `verifySession()` → prüft Session + aktiv (cached)
- `requireAdmin()` → nur Role `admin`
- `requireRole(roles)` → flexible Role-Prüfung
- `requirePageAccess(pageKey)` → prüft `allowed_pages` Array pro Seite

Diese Funktionen rufen `redirect()` bei Failure — **nicht umschreiben, direkt verwenden**.

Rollen in `src/lib/admin-roles.ts`: `admin`, `support`, `marketing`, `creator`, `pack_creator` (5 Rollen). `ROLE_PRIORITY` (admin gewinnt), `getEffectiveRoles()` normalisiert `role` + `roles`.

**Niemals Auth-Logik von Hand neu schreiben oder umgehen.** Middleware (`src/middleware.ts`) erzwingt den Flow zusätzlich — nicht daran vorbei arbeiten.

### Server Components First

- Pages sind standardmäßig **async Server Components** (`export default async function Page()`).
- Client-Interaktivität nur in separaten `"use client"` Komponenten.
- Mutations über **Server Actions** (`"use server"`) + `revalidatePath()` nach Erfolg.
- Data Fetching direkt in Server Components (kein SWR / React Query in bestehenden Flows — nicht einführen ohne Absprache).

### Performance & Daten-Laden — Active-Timeframe-Only (CRITICAL, verbindlich)

**Wenn eine Seite mehrere Timespans anbietet (z. B. 3h / 12h / 24h / 7d / 30d / lifetime), wird beim initialen Render NUR der aktuell aktive Timespan geladen. NIEMALS alle Timespans vorladen.**

- **Kein Preload aller Zeiträume.** Nicht „auf Vorrat" alle Fenster vorberechnen. Der neue Timespan wird erst gefetcht, wenn der User ihn auswählt (`?period=`-Wechsel → eigener Query). Bereits angesehene Fenster dürfen optional in-memory gecached werden, aber nie eager geladen.
- **Kein Preload versteckter Tabs.** Bei tab-Seiten lädt initial NUR der aktive Tab seine Daten. Hidden Tabs werden erst beim Klick geladen (lazy, eigene `<Suspense key={`${tab}-${period}`}>`-Boundary). Eine tabbed Seite darf NIEMALS alle Tab-Queries auf einmal feuern.
- **Kein Laden versteckter Komponenten.** Drawer, Modals, Drilldowns, expandierte Rows, collapsed Sections: keine Heavy-Queries bevor sie geöffnet werden.
- **Lifetime-Fenster bounden.** Unbounded Lifetime-Scans vermeiden — gecappte Lookbacks nutzen (`windowDateFilterCapped`, Referenz: deposit-bonus / rakeback ROI), sonst hängt die Query.
- **Caching + Timeout:** Heavy Queries via `unstable_cache` keyed auf `(period, …)` (60s/300s), und über die `safeQuery`-Timeout-Wrapper laufen lassen, damit langsame Queries zu einem Fallback degradieren statt die Seite zu blocken.
- **Search/Filter/Pagination dürfen keine Full-Table-Loads triggern**, wenn serverseitige Einschränkung möglich ist.

Referenz-Pattern: `src/lib/queries/insights-rewards/_period.ts` + die lazy-tab-Struktur der Insights-Seiten + der Dashboard-Period-Selector. Jede neue Seite mit Timespan-/Tab-Auswahl folgt diesem Muster.

**Merkregel:** Eine Timespan-/Tab-Seite, die beim Laden mehr als das aktive Fenster + den aktiven Tab abfragt, ist falsch gebaut.

### Validation

- Alle Input-Validation über Zod-Schemas mit `safeParse()`.
- Fehler-Messages aus Zod ableiten: `parsed.error.issues[0].message`.
- **Keine eigenen Validierungs-Frameworks oder Custom-Lösungen einführen.**

### Error Handling Pattern (Client Components)

Standard-Pattern aus der Codebase (z.B. `src/app/(admin)/admin-users/create-dialog.tsx`):

```typescript
try {
await someServerAction({...});
toast.success("...");
setOpen(false);
} catch (err) {
toast.error(err instanceof Error ? err.message : "Fallback message");
} finally {
setLoading(false);
}
```

Toasts via `sonner`, nicht eigene Notification-Systeme einführen.

### Formatierung & Utilities (reuse, don't rebuild)

Vorhandene Utilities in `src/lib/utils/format.ts`:

- `formatCurrency(amount)` — USD
- `formatDate(date)` — "MMM d, yyyy"
- `formatDateTime(date)` — "MMM d, yyyy HH:mm"
- `formatRelative(date)` — "2 hours ago"
- `formatNumber(num)` — Locale-aware

**Erste Prüfung immer:** Gibt es das schon? Wenn ja → verwenden, nicht nachbauen.

### Konstanten (Farben, Status)

`src/lib/constants.ts` enthält:

- `ROLE_COLORS` — Rollen → Tailwind Classes
- `STATUS_COLORS` — Statuses → Tailwind Classes
- `AFFILIATE_LEVEL_COLORS` — Affiliate Tiers

Pattern: `"bg-{color}-500/15 text-{color}-600 dark:text-{color}-400 border-{color}-500/30"`

**Keine eigenen Color-Maps erfinden** — bestehende erweitern oder wiederverwenden.

### Finanzielle Präzision

- Alle Geldbeträge: `Decimal(20,2)` in der DB.
- Decimal-Operationen über die bestehenden Decimal-Utilities, **nicht** JS-Number-Arithmetik.
- Bei Analytics / GGR / NGR / PnL Berechnungen: **bestehende Query-Funktionen in `src/lib/queries/` referenzieren**, nicht von Hand neu implementieren.
- PnL-/Revenue-/Cost-Logik niemals “zur schnellen UI-Reparatur” lokal im Frontend nachbauen, wenn bereits Query- oder Aggregationslogik existiert.

### Ledger-basierte Transaktionen (CRITICAL)

- Balance-Änderungen werden **immer** über `ledger_transactions` verbucht (immutable audit trail).
- Felder `balance_before` / `balance_after` dokumentieren jede Veränderung.
- **Niemals direkt `balances.update()` ohne dazugehörigen Ledger-Eintrag** — das würde die Audit-Chain brechen.
- Für Multi-Step Mutations: `db.$transaction([...])` verwenden (Referenz: Battle-Cancellation in `src/app/(admin)/battles/actions.ts`).

#### Voucher = Card (gleiches Item, kein Unterschied) — CRITICAL Modell-Regel

- **Ein Voucher ist dasselbe wie eine Card: ein Item, kein Unterschied.** Gleiche Behandlung in Wert, Inventar, PnL/GGR und Anzeige. Niemals als eigene "Voucher-Klasse" behandeln, die anders zählt als eine Card.
- **`battle_excess_to_voucher` ist Teil eines ganz normalen Battle-Wins** (der Voucher-Rest, den die Inventory-Card untercountet — Card-Value + Voucher-Value = voller Win). `battle_refund` ist die Cash-Leg desselben normalen Wins. **Beide bekommen KEINE separate Anzeige** in GGR-/Cost-Breakdowns — in die normale **"Pack & battle wins"**-Zeile mergen. Es ist ein normaler Win, kein Sonderfall.
- **Voucher/Card exchangen oder redeemen ist eine normale User-Aktion und KEIN House-Verlust.** Der Wert wurde bereits beim Entstehen des Items verbucht; das spätere Exchange/Redeem ist neutral (kein Cost, kein Loss, keine GGR-/PnL-Bewegung). Niemals einen Exchange als Verlust/Cost zählen oder anzeigen.

### Admin Audit

- Admin-Aktionen werden über `createAdminAuditEvent()` geloggt.
- Bei neuen Admin-Features: Audit-Eintrag immer einbauen.

### Staff-Exclusion in Analytics

- Customer-Analytics schließen Staff **und Creator** aus. **Kanonisch:** `getMetricsScope()` in `src/lib/metrics/scope.ts` mit `CUSTOMER_EXCLUDED_ROLES = ['admin','support','creator']` (Creator werden seit 2026-06-03 **wholesale** gedroppt) + `excluded_users`-Blacklist (`src/lib/queries/_blacklist.ts`).
- **Legacy:** `EXCL_STAFF_FRAG` (`src/lib/queries/_exclude-staff.ts`) droppt nur `['admin','support']` (Creator bleiben drin) — das ist **nicht** die kanonische Customer-Scope. Für GGR/NGR/PnL/Wager immer `scope.ts` verwenden.
- Bei neuen Analytics-Features diese Exclusion nicht vergessen — sonst werden Metriken verzerrt.

### File Organization (Feature-Based)

```text
src/app/(admin)/{feature}/
├── page.tsx           # Server Component (async default export)
├── actions.ts         # Server Actions ("use server")
├── {component}.tsx    # Client Components ("use client")
└── [id]/              # Dynamic routes
```

**Bei neuen Features: gleiche Struktur spiegeln, keine alternativen Layouts erfinden.**

### Naming Conventions

- `camelCase` — Funktionen, Variablen
- `PascalCase` — Komponenten, Typen, Interfaces
- `kebab-case` — Dateinamen, Routen
- `SCREAMING_SNAKE_CASE` — Konstanten

### TypeScript

- `strict: true` — **keine `any`-Shortcuts** einführen.
- Path alias: `@/*` → `./src/*`
- Explizite Return Types an API-Boundaries (Server Actions, Query-Funktionen, DAL).

### Linting

- ESLint 9 mit Flat Config (`eslint.config.mjs`), extends `next/core-web-vitals` + `next/typescript`.
- Kein Prettier konfiguriert — an bestehenden Code-Stil halten.

---

## Teil 3 — Quick Reference: Wichtige Dateien

| Zweck | Pfad |
|---|---|
| Main DB Client | `src/lib/db.ts` |
| Admin DB Client | `src/lib/admin-db.ts` |
| Auth / Permissions / DAL | `src/lib/dal.ts` |
| Session / JWT | `src/lib/session.ts` |
| Role Definitions | `src/lib/admin-roles.ts` |
| Format Utilities | `src/lib/utils/format.ts` |
| Constants (Colors, Status) | `src/lib/constants.ts` |
| Main Schema | `prisma/schema.prisma` |
| Admin Schema | `prisma/admin/schema.prisma` |
| Middleware | `src/middleware.ts` |
| UI Primitives (shadcn) | `src/components/ui/` |
| Admin Layout | `src/app/(admin)/layout.tsx` |
| Auth Layout | `src/app/(auth)/layout.tsx` |
| Query-Module | `src/lib/queries/` |
| Seed-Script (Admin) | `prisma/admin/seed.ts` |
| Admin Prisma-Config (`db push`/`db execute`) | `prisma/admin/prisma.config.ts` |
| Sidebar-Nav + `ICONS`-Map (React #130) | `src/components/app-sidebar.tsx` |
| Render-/Responsive-Verify-Harness | `e2e/responsive/*` + `playwright.responsive.config.ts` |
| Dev-only Render-Fixtures | `src/app/responsive-fixture/*` |
| **Live Operating-Manual + Session-State** | `AGENT_HANDOFF.md` |
| **Architektur + Domain-Wissen** | `ONBOARDING.md` |

### Build / Dev Scripts

```bash
npm run dev              # Next.js dev (Turbopack)
npm run build            # Prisma generate (beide DBs) + Next build — AUTORITATIVER Gate vor Push
npm run start            # Production Server
npm run lint             # ESLint
npm run admin:seed       # Admin DB Seed

# Admin-DB Schema anwenden — die Admin-DB ist db-push-managed:
npx prisma db push    --schema=prisma/admin/schema.prisma --config=prisma/admin/prisma.config.ts
npx prisma db execute --file <sql>                        --config=prisma/admin/prisma.config.ts

# ⚠️ NICHT benutzen: npm run admin:migrate  (= `prisma migrate dev` → destruktiver Reset auf db-push-managed DB)
```

### Env-Variablen (Pflicht)

- `DATABASE_URL` — Main DB Connection
- `ADMIN_DATABASE_URL` — Admin DB Connection
- `SESSION_SECRET` — JWT Signing Key
- `ADMIN_SEED_PASSWORD` — Initial Admin Password (Default: "CHANGEME")

### Bekannte Gotchas / Fallen (aus Sessions gelernt — Stand 2026-06-05)

Volle, aktuelle Liste in `AGENT_HANDOFF.md` (§ Gotchas) + `ONBOARDING.md` (§7). Die durablen:

- **Stale lokale Game-DB** → live Admin-Pages werfen lokal (fehlende Tables). Solche Pages über dev-only Fixtures rendern (`src/app/responsive-fixture/*`); „lokal kaputt" nicht mit „prod kaputt" verwechseln.
- **React #130 (sidebar icons):** jeder Nav-`icon`-String **muss** in der `ICONS`-Map in `src/components/app-sidebar.tsx` existieren — sonst Runtime-Crash. Neuer Nav-Eintrag → Icon dort eintragen.
- **`gift_cards` + `vouchers` liegen in der MAIN-DB** (nicht Admin) → Bulk-Delete/Mutation auf ihnen = MAIN-Write = **verboten**. Admin-DB-Äquivalent gibt es nur für Gift-Cards (Cancel-Action), nicht für Vouchers.
- **PowerShell schreibt UTF-8 mit BOM** → bricht `.sql`-Files für Postgres. SQL über Bash/`printf` schreiben.
- **Stale `.next`** kann `tsc` fehlschlagen lassen (referenziert gelöschte Routen) → vor Re-Gate `.next` löschen.
- **Keine Function-Props Server→Client** (RSC-Grenze) — Next.js 15 crasht; nur serialisierbare Primitives / String-Enums. Surft nur im `npm run build`-Gate auf, nicht in `tsc`.

---

## Verhalten bei Unklarheiten (Kurzregel zum Merken)

1. **Existiert schon?** → Codebase prüfen, wiederverwenden.
2. **Nicht klar?** → Nachfragen, nicht raten.
3. **DB-Info gebraucht?** → User fragen, niemals annehmen.
4. **Verifiziert?** → Wenn nein: Problem benennen, nicht umgehen.
5. **Fertig?** → Erst nach Verifikation, nicht nach bloßem Code-Schreiben.
6. **Im Browser sichtbar/testbar?** → Browser prüfen, bevor du `DONE` sagst.