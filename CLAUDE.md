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

## 🗄️ ABSOLUTE BACKEND-REGEL — Index-or-ClickHouse (Owner, 2026-06-17, höchste Priorität, gleichrangig mit Prod-DB-Policy)

**Das Backend wurde komplett umgestellt. Ab sofort wird JEDER Read ausschließlich über genau einen von zwei Pfaden bedient: (1) indexierte Postgres-Query ODER (2) ClickHouse. Es gibt keinen dritten Weg.**

### Die EINE Regel
> **Jeder Read trifft entweder einen bestätigten Postgres-Index ODER läuft über ClickHouse. Kein unindexierter Read, kein Full-Table-/Seq-Scan auf der MAIN-DB — niemals, auch nicht „nur kurz" oder „nur einmal".**

Warum: Beide Pfade sind die einzigen, die unter realer Last + Concurrency auf der prod MAIN-DB skalieren. Ein unindexierter Scan auf MAIN ist ein Prod-Incident, kein Implementierungsdetail.

### Pfad 1 — Indexierte Postgres-Query
- **Wofür:** live / per-user / money-exact Reads (z. B. `dashboard_stats`, User-Detail, Listen, operative Boards). Diese bleiben bewusst auf indexiertem Postgres (zero CDC-Lag, cent-exakt).
- **Pflicht:** die Query MUSS einen Index treffen — per read-only `EXPLAIN ANALYZE` gegen prod verifiziert (Index-Scan, kein Seq-Scan). Probe über temporäres `node --env-file=.env`-Script mit `pg` (uncommitted, druckt keine Secrets, danach löschen).
- **MAIN ist read-only** → der Agent legt einen fehlenden Index **nicht selbst an**. Stattdessen das `CREATE INDEX CONCURRENTLY`-Statement in **`prisma/recommended-indexes.sql`** ergänzen und dem Owner zum Anwenden flaggen. Eine Query, die ohne diesen Index nur per Seq-Scan läuft, gilt bis dahin als **BLOCKED**, nicht „done".

### Pfad 2 — ClickHouse
- **Wofür:** heavy Aggregate / Analytics / Fan-out (`/insights/*`, `/analytics/*`, creators-/rewards-analytics, dashboard-Legs).
- **Pflicht:** über **`resolveAdminRead(surfaceKey, { pg, ch, compare })`** (`src/lib/clickhouse/resolve-read.ts`) verdrahten, gated durch **`getAdminReadMode`** (`src/lib/feature-flags/admin-read-source.ts`). CH-Twin muss cent/count-exakt gegen Postgres geprüft sein (Parity-Harness, `TZ=UTC`, zweimal), bevor der Surface-Key in `CUTOVER_DEFAULT_CLICKHOUSE`. Per-Surface Instant-Rollback via Edge Config bleibt erhalten.

### Neue Queries = Pflicht-Konstrukt, alter PG-Layer = Legacy
- **Jede NEUE Query / jedes neue Read-File MUSS auf dem Index-or-ClickHouse-Konstrukt aufbauen.** Keine neuen plain/unindexierten Prisma-/PG-Queries mehr.
- Der bestehende direkte Prisma-/PG-Query-Layer gilt als **Legacy**. Wenn du einen Read anfasst, erweiterst oder eine Page neu baust: bring ihn auf einen bestätigten Index oder einen ClickHouse-Twin — nicht „so lassen wie er war".
- **Verboten:** ein neues heavy Aggregate direkt auf MAIN ohne Index-Beleg oder CH-Twin; unbounded Lifetime-Scans (`windowDateFilterCapped` nutzen); „schnelle" Raw-Queries an der Regel vorbei.

### Pflicht: Shell-first Suspense-Streaming (gleichrangig mit Index-or-ClickHouse)
- **Jede Admin-Page mit einem nicht-trivialen Read MUSS shell-first streamen.** Die Page-`page.tsx` rendert den `PageHero`-Shell (+ statische Controls) **sofort** und lädt die Daten in einer `async`-Child-Komponente hinter einer **`<Suspense fallback={<…Skeleton/>}>`**-Boundary. **Niemals** den heavy Read direkt im Page-Body awaiten — das blockiert First Paint.
- **Pflicht-Begleiter:** eine `loading.tsx`, die denselben Shell + Skeletons rendert (Skeletons aus `@/components/loading-skeletons`); bei Timespan-/Tab-Seiten `<Suspense key={`${tab}-${period}`}>`. Referenz: `/creators/analytics`, `/crm`.
- Der Read selbst läuft trotzdem über `safeQuery`/`safeQueryOrNull` + Timeout, ist gecached (`unstable_cache`, Active-Timeframe-Only) **und** über Pfad 1 (Index) oder Pfad 2 (ClickHouse) verdrahtet. Streaming ersetzt KEINEN der beiden Pfade — es kommt obendrauf.

### Pflicht-Checkliste pro Read / Page (alle Punkte, sonst nicht „done")
1. Read über Pfad 1 (bestätigter Index, per `EXPLAIN` belegt — oder dokumentiert warum Seq-Scan optimal ist) **oder** Pfad 2 (`resolveAdminRead` + CH-Twin, parity-proven).
2. `page.tsx` = Shell sofort + `<Suspense>` + `loading.tsx` (kein Top-Level-await des heavy Reads).
3. `safeQuery`/Timeout + `unstable_cache` (Active-Timeframe-Only, keine hidden Tabs/Timespans eager laden).
4. Money Decimal-safe (`toString(sum)`→`toNumber`, nie Float), House-POV-Farben.
5. tsc + lint + `npm run build` grün; bei UI Browser-/Render-Check.
6. CH-Twin (falls gebaut) bleibt dormant (off/comparison) bis cent/count-exakte Parität (`TZ=UTC`, zweimal) **und** Logged-in-Render-Check — erst dann in `CUTOVER_DEFAULT_CLICKHOUSE`.

**Volle Mechanik (Caching, Suspense-Streaming, Active-Timeframe-Only, `safeQuery`, House-POV-Farben, Checkliste neue Page):** **`docs/BACKEND_QUERY_SYSTEM.md`** — vor jeder Read-/Page-Arbeit lesen. Diese Regel hebt KEINE der Prod-DB-Regeln auf (MAIN bleibt read-only).

**Merkregel:** Bedient eine Query weder einen bestätigten Index noch ClickHouse, ODER blockt eine Page First Paint statt zu streamen → sie ist falsch gebaut und darf nicht shippen.

---

## ⚡ MINIMAL-OVERHEAD / SPEED RULE — skip everything not 100% needed (Owner, 2026-07-12, STRICT)

**Owner directive (verbatim): "skip as much of all of this if it's not 100% needed — if it works without it, don't do it. yallah."** Do the SMALLEST amount of work that safely ships the change. Cut ceremony; ship fast.

- **Match the gate to the change — do NOT over-verify:**
  - Docs / markdown / comment-only edit → **no gate at all** (no `npm install`, no tsc/lint/build). Just commit + push.
  - Pure CSS / className / copy / static-JSX edit → **`tsc --noEmit` + `npm run lint` is enough**; do NOT run `npm run build`.
  - Run the full **`npm run build` ONLY when the change can break what ONLY the build catches**: Server↔Client (RSC) boundaries, new/changed imports or exports, types, data flow, new deps, or route/config/prisma-generate changes.
- **No redundant re-verification:** skip the separate composed-main build unless MULTIPLE agents changed INTERDEPENDENT code in the same area. One fitting gate → push.
- **No unneeded ceremony:** no browser render unless asked; no belt-and-suspenders double-checks; don't spin a fresh worktree + full `npm install` for a trivial edit that can be shipped cleanly without it.
- **NO headless rendering / Playwright / screenshots to verify UI before pushing (Owner, 2026-07-12, EXPLICIT — verbatim: "u dont need to render or playwright anything, just push"):** for ANY UI/design change, do NOT start the dev server, the responsive Playwright harness (`e2e/responsive/*`), the dev fixtures (`src/app/responsive-fixture/*`), or any screenshot/visual-verify pass as a pre-push gate. The gate for a UI change is `npx tsc --noEmit` + `npm run lint` (full `npm run build` only when the change-class above requires it) → then **push**. The OWNER reviews the visual result himself in his browser. This applies to the main agent AND every background/workflow/sub-agent — never brief an agent to render/screenshot a UI change. Rendering/Playwright happens ONLY when the owner explicitly asks for it in that message.

**Hard floor — this rule does NOT override these (NEVER skipped):** MAIN / prod-DB stays strictly read-only; never commit `.env` / secrets / `src/generated` / `recent-pushes.json`; the Index-or-ClickHouse backend rule; and honest reporting. Speed means cutting *verification overhead* — NEVER skipping *safety* rules or misreporting what was actually checked.

---

## ⚡ Arbeitsmodus — Standard ist inline (User-Override, 2026-07-12, ersetzt die alte Parallel-Pflicht)

**User-Override (verbatim): "i dont want that fucking bullshit, make it good and fast again".** Die alte Zwangsregel „jede Message → sofort Background-Agent, nur 1–2-zeilige Ack" ist **aufgehoben**. Sie hat Sessions massiv verlangsamt (Dispatch-Overhead, Worktree-Setup, Warten auf Agent-Ergebnisse für Dinge, die eine direkte Antwort gebraucht hätten) und wird durch normales Arbeiten ersetzt.

**Neuer Default: Arbeite direkt inline, in diesem Turn.** Lies, editiere, verifiziere (tsc/lint, ggf. build) und antworte selbst — normal, wie ein direkter Coding-Assistant. Kein automatisches Abfeuern eines Background-`Agent` nur weil eine neue Message kommt. Kein erzwungenes 1–2-Zeilen-Ack-Protokoll — antworte normal.

**Nutze `Agent` (background) oder `Workflow` gezielt, wenn Parallelität einen echten Vorteil bringt:**
- Der User wirft mehrere echt unabhängige Tasks nacheinander rein und will, dass du am aktuellen weiterarbeitest, während ein anderer im Hintergrund läuft.
- Große, in viele unabhängige Einheiten zerlegbare Jobs (Audit über N Pages, ein Fix pro Reward-Typ, breite Recherche über viele Files) — hier lohnt sich echtes Fan-out.
- Lange, unabhängige Recherche/Exploration, deren Suchweg den Hauptkontext nur unnötig aufbläht (nicht das Ergebnis selbst).

**Bleibt bindend, unabhängig von inline vs. delegiert:** Hotspot-Kollisionsvermeidung, Commit/Push-Disziplin, DB-Policy, Index-or-ClickHouse-Regel, Minimal-Overhead-Gate (§ oben), Honest-Reporting. Diese Regel ändert nur *wer die Arbeit macht*, nicht die Sicherheits-/Qualitätsstandards.

**Merkregel:** Frag dich nicht mehr reflexhaft "Agent oder inline?" — Standard ist inline. Nur zu Agent/Workflow greifen, wenn es die Aufgabe nachweislich schneller oder breiter abdeckt (echte Unabhängigkeit, echte Breite), nicht weil "das ist die Regel".

---

## ⚙️ Workflows / Multi-Agent-Orchestrierung — opt-in für echte Breite (überarbeitet 2026-07-12)

**Kein Pflicht-Einstiegspunkt mehr.** Die alte Regel „jede nicht-triviale Aufgabe beginnt mit Workflow" ist mit der Arbeitsmodus-Regel oben aufgehoben (User-Override 2026-07-12: „make it good and fast again"). `Workflow` ist ein Werkzeug, kein Pflichtschritt.

**Nutze `Workflow`, wenn die Aufgabe wirklich Struktur braucht:** Fan-out über viele gleichartige, unabhängige Einheiten (z. B. ein Fix pro Reward-Typ über 10 Pages, ein breiter Audit-Sweep, tiefe Multi-Source-Recherche) gefolgt von Verify-/Synthese-Phasen — dort liefert es echten Mehrwert. Für normale einzelne Tasks (ein Bugfix, ein Feature auf einer Page, eine Query anpassen) ist inline schneller und genauso gut.

- **In jedem Workflow/Agent unverändert bindend:** keine Prod-DB-Writes (read-only Hard-Rule), Build-Gate passend zur Änderung (§ Minimal-Overhead), Hotspot-Kollisionen vermeiden, Honest-Reporting.

**Merkregel:** Großer, zerlegbarer Job mit echter Breite → Workflow. Alles andere → inline.

---

## 🚀 Push-Disziplin — häufig & inkrementell pushen (User-Regel, 2026-06-05)

**Der User wartet NICHT 40 Minuten, während du 5 Sachen sammelst und alles zusammen pushst.** Jede fertige, verifizierte (tsc + lint + `npm run build` grün) Aufgabe wird SOFORT einzeln committet + gepusht — niemals zu einem Sammel-Push gebündelt.

- **Ein Task fertig → sofort pushen.** Nicht auf andere laufende Tasks warten, nicht batchen.
- **Unabhängige Tasks parallel in isolierten git-Worktrees** (`isolation: "worktree"` mit eigenem `npm install` + eigenem `.next` — **`npm install`, NICHT `npm ci`** (der committete `package-lock.json` weicht ab, `npm ci` schlägt fehl); NICHT node_modules junctionen, sonst korrumpiert ein paralleles `prisma generate` den Main-Checkout) bauen und jeweils eigenständig nach `main` pushen (bei non-fast-forward: `git fetch origin && git rebase origin/main && git push origin HEAD:main`, retry bis es durchgeht). So blockiert ein langer Job (großer Workflow) nicht den EINEN Build-Slot des Main-Checkouts, und kleine Tasks verhungern nicht in einer Queue.
- **Niemals einen großen ungepushten Stau anhäufen.** Mehrere offene Tasks → jeden so früh wie möglich einzeln rausschicken.
- Build-Gate, Hotspot-Vermeidung, no-prod-DB-Writes und Honest-Reporting bleiben bindend — aber INNERHALB dieser Regeln gilt: so früh + so oft pushen wie möglich.

**Merkregel:** Ein Task = ein Push. Niemals 5 Tasks sammeln und am Ende einmal pushen.

**Owner-Regel (2026-06-12): Wenn du fertig bist → alles pushen.** Bevor du „done" meldest: **commit + push** alle Änderungen zu deiner Aufgabe. Kein Shippedes lokal liegen lassen. Nie committen: `.env`/Secrets, `src/generated/*`, `recent-pushes.json`, temp `_verify-*` Scripts. Nach Push: `git status` clean für Feature-Files — oder explizit sagen, was offen blieb und warum.

**Production (2026-06-13):** Live admin = https://pokewin-admin.vercel.app · Vercel project `packy-admin-dashboard` · **`productionBranch: main`** · push to `origin/main` = auto production deploy. Feature branches are preview-only until merged to `main`.

---

## 🔁 Staying responsive across a session (trimmed 2026-07-12)

_The parallel-by-default mandate this section used to carry is gone (see § Arbeitsmodus above). What's left is just good practice, not an overhead multiplier._

- Treat every new user message as a possible new task, correction, or priority change — read it and integrate it with current state before acting. A newer instruction overrides an older one.
- Don't stop at one file if the task obviously spans multiple systems (UI + query + shared util). Don't ship partial logic while shared calculations, filters, or dashboard surfaces go inconsistent.
- Short follow-ups ("also do this", "same for this page", "now check mobile") continue the current task/plan — don't treat them as unrelated asks.
- For substantial completed work, summarize plainly: what changed, cross-system impacts checked, remaining risks, next steps. No forced format beyond that.

---

## 🔒 Browser-Verifikation & Done-Kriterien (CRITICAL)

> **Owner-Override (2026-07-02, gilt für alle Agents/Modelle in diesem Repo):** Keine Browser-Verifikation nötig, bevor gepusht wird — einfach pushen. Und nach dem Push muss NICHT bestätigt werden, ob der Push/Deploy live gegangen ist oder sonst irgendwas dazu nachgeprüft werden. `tsc` + `lint` grün (+ `npm run build` wo praktikabel) reichen als Gate; Punkt 5 ("Bei UI-/Admin-Aufgaben: Browser-Verifikation erfolgt") in der Done-Checkliste unten ist damit ausgesetzt. Der Rest der Sektion (Definition of Done Punkte 1–4/6, Regression-Sweep, Incident-Modus, Honest Reporting) bleibt unverändert gültig.

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

### Agent-Parallelisierung (Arbeitsweise, wenn Agents/Workflows genutzt werden)

Die Top-Regel oben (§ ⚡ Arbeitsmodus) ist bindend: **Standard ist inline**, Agents/Workflows nur bei echtem Vorteil (Breite, echte Nebenläufigkeit). Dieser Abschnitt definiert die Mechanik, **wenn** du dich für Agents/Workflow entscheidest — er ist kein Argument dafür, sie öfter einzusetzen.

**Regeln für parallele Agents (falls eingesetzt):**

1. **Große, in Units zerlegbare Jobs → ein Agent pro Unit.** Audit-Sweeps über mehrere Pages / Surfaces / Query-Files gehören in N parallele Agents, nicht in eine lange Inline-Session, weil dort Fan-out tatsächlich schneller ist als seriell inline. Normale einzelne Tasks bleiben inline (§ Arbeitsmodus).

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

7. **Default bleibt inline** (§ ⚡ Arbeitsmodus) — Einzel-Fixes, einzelne Feature-Requests, einzelne Page-Changes, Codebasis-Fragen, Live-Troubleshooting: alles normal direkt bearbeiten. Agent/Workflow nur greifen, wenn Punkt 1 oben zutrifft (echte Breite/Units) oder der User mehrere unabhängige Tasks parallel laufen lassen will.

8. **Wenn der User mehrere unabhängige Tasks nacheinander schickt** und ausdrücklich parallel arbeiten will: neuen Agent starten statt zu warten, kurz sagen welche Files er anfasst + Kollisionsrisiko, und am aktuellen Task weiterarbeiten.

**Merkregel:** Standard ist inline. Agent/Workflow nur wenn es die Aufgabe echt schneller oder breiter macht — nicht als Reflex.

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