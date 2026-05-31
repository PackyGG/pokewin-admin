import { Network } from "lucide-react";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { ensureEmployeeBoardSchema } from "@/lib/employee-board/ensure-schema";
import {
  listDiscordPlacements,
  listDiscordServers,
} from "@/lib/employee-board/discord-servers";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmployeeBoard } from "./employee-board";

export const metadata = { title: "Employee Board" };

export default async function EmployeesPage() {
  await requirePageAccess("/employees");
  // Self-heal the board tables (no migration file — same fallback the
  // salary page uses). Swallow here; the queries below surface a
  // clearer error if the DB is genuinely unreachable.
  await ensureEmployeeBoardSchema().catch(() => {});

  const [
    employees,
    workspaces,
    placements,
    managers,
    discordServers,
    discordPlacements,
  ] = await Promise.all([
    // SECURITY: this board is broader-access than the founders-only
    // /salaries page. Select ONLY id / discord_name / active — never
    // eth_address, salary_usdt, max_per_payout or notes, so no pay or
    // wallet data can leak to the client.
    adminDb.salary_employees.findMany({
      select: { id: true, discord_name: true, active: true },
      orderBy: [{ active: "desc" }, { discord_name: "asc" }],
    }),
    adminDb.employee_workspaces.findMany({
      orderBy: { position: "asc" },
      select: { id: true, name: true, position: true },
    }),
    // V2 multi-section model: one row per (employee, workspace), so an
    // employee can appear in multiple sections. Each placement becomes
    // its own card on the board, keyed by `id` (the placement id) — NOT
    // the employee id, which would collide for someone who's in two
    // sections.
    adminDb.employee_board_placements.findMany({
      select: {
        id: true,
        employee_id: true,
        workspace_id: true,
        roles: true,
        position: true,
      },
      orderBy: { position: "asc" },
    }),
    // Managers sit in the row above the columns. Each carries its linked
    // workspace ids (one connector line per id). Same security rule —
    // employee_id is joined to the safe `employees` list below, never to
    // pay/wallet columns.
    adminDb.employee_managers.findMany({
      orderBy: { position: "asc" },
      select: {
        id: true,
        employee_id: true,
        workspaces: { select: { workspace_id: true } },
      },
    }),
    // Discord servers + their placements live in their own tables (not
    // Prisma models — see ensure-schema.ts comment), so they're loaded
    // via the typed raw-SQL wrappers. Same security rule — no
    // pay/wallet data anywhere in the payload.
    listDiscordServers(),
    listDiscordPlacements(),
  ]);

  // Managers are rendered in their own row, so their placements are
  // excluded from the columns below. Demoting a manager restores the
  // placements (rows are kept untouched in the DB).
  const managerEmployeeIds = new Set(managers.map((m) => m.employee_id));
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  // Build placement cards by joining to the safe employee record.
  // Skip rows whose employee is currently a manager OR has been removed
  // from the salary registry (FK CASCADE makes the latter rare but
  // possible during a race).
  const placementCards = placements
    .filter((p) => !managerEmployeeIds.has(p.employee_id))
    .map((p) => {
      const emp = employeeById.get(p.employee_id);
      if (!emp) return null;
      return {
        // Card identity = placement id (NOT employee id), so a person
        // placed in 2 sections has 2 cards with distinct drag handles.
        id: p.id,
        employeeId: p.employee_id,
        discordName: emp.discord_name,
        active: emp.active,
        workspaceId: p.workspace_id ?? null,
        roles: p.roles,
        position: p.position,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // Discord placement cards — same shape as workspace placement cards
  // but tagged with `kind: "discord"` and a `discordServerId` instead
  // of a `workspaceId`. Card identity prefix avoids any possible
  // collision with workspace-placement UUIDs (both come from
  // gen_random_uuid() so collisions are astronomically unlikely, but
  // the prefix also lets the client immediately tell them apart for
  // routing the correct server action on drag/drop and for the
  // distinct visual marker in the discord section).
  const discordPlacementCards = discordPlacements
    .filter((p) => !managerEmployeeIds.has(p.employee_id))
    .map((p) => {
      const emp = employeeById.get(p.employee_id);
      if (!emp) return null;
      return {
        id: `discord:${p.id}`,
        placementId: p.id,
        employeeId: p.employee_id,
        discordName: emp.discord_name,
        active: emp.active,
        discordServerId: p.discord_server_id,
        roles: p.roles,
        position: p.position,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  // Real-customer employees that have ZERO placements (workspace OR
  // discord) show up in the Unassigned pool as a synthetic card. The
  // user's spec is explicit: a person in N workspaces / M discord
  // servers (N+M > 0) is NOT unassigned. Skip managers.
  //
  // Notes on the workspace branch:
  //   - We include rows with NULL workspace_id in `placedEmployeeIds`
  //     to preserve the existing legacy "roles-only Unassigned" card
  //     behaviour (those rows are still rendered as cards in
  //     Unassigned via `placementCards`). If we excluded them here a
  //     legacy row would render once as a placement card AND once as
  //     a synthetic card for the same employee.
  //   - For discord we include all placements (the table has NOT NULL
  //     discord_server_id, no legacy null concept).
  const placedEmployeeIds = new Set<string>([
    ...placements.map((p) => p.employee_id),
    ...discordPlacements.map((p) => p.employee_id),
  ]);
  const unplacedCards = employees
    .filter(
      (e) => !managerEmployeeIds.has(e.id) && !placedEmployeeIds.has(e.id),
    )
    .map((e) => ({
      // Synthetic id — the client uses the `synthetic` flag to know
      // there's no real placement row behind this card yet.
      id: `unplaced:${e.id}`,
      employeeId: e.id,
      discordName: e.discord_name,
      active: e.active,
      workspaceId: null as string | null,
      roles: [] as string[],
      position: Number.MAX_SAFE_INTEGER, // sort to the end of Unassigned
      synthetic: true,
    }));

  const allCards = [
    ...placementCards.map((c) => ({ ...c, synthetic: false })),
    ...unplacedCards,
  ];

  // Manager blocks: join each manager to the SAFE employee record for its
  // display name / active flag, and carry the workspace ids it links to.
  const managerCards = managers
    .map((m) => {
      const emp = employeeById.get(m.employee_id);
      if (!emp) return null; // employee left the registry (FK CASCADE makes this rare)
      return {
        id: m.id,
        employeeId: m.employee_id,
        discordName: emp.discord_name,
        active: emp.active,
        workspaceIds: m.workspaces.map((w) => w.workspace_id),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  // Candidates for the "Add manager" picker: every employee not already a
  // manager (so an admin can promote anyone, even someone in a column).
  const managerCandidates = employees
    .filter((e) => !managerEmployeeIds.has(e.id))
    .map((e) => ({
      id: e.id,
      discordName: e.discord_name,
      active: e.active,
    }));

  // Section "+ Add member" pickers need the full non-manager employee
  // list — the client filters out who's already placed in a section per
  // its own data. Identical to managerCandidates today, but kept as its
  // own list so a future change to "managers can also be placed in a
  // column" doesn't silently re-include them.
  const placeableEmployees = employees
    .filter((e) => !managerEmployeeIds.has(e.id))
    .map((e) => ({
      id: e.id,
      discordName: e.discord_name,
      active: e.active,
    }));

  const workspaceList = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
  }));

  const discordServerList = discordServers.map((s) => ({
    id: s.id,
    name: s.name,
  }));

  // Count of TRULY-unassigned non-manager employees: people with NO
  // workspace placement (workspace_id NOT NULL) AND NO discord
  // placement. Computed server-side and passed to the client so the
  // badge math is unambiguous regardless of legacy roles-only
  // placement rows (workspace_id IS NULL) which we still render as
  // cards in the Unassigned column but which don't count toward "is
  // this employee placed somewhere?". Mirrors the user-spec formula:
  //   N = |salary_employees \ managers
  //         − DISTINCT employee_id WHERE workspace_id IS NOT NULL
  //         − DISTINCT employee_id IN discord placements|
  const placedSomewhereIds = new Set<string>([
    ...placements
      .filter((p) => p.workspace_id !== null)
      .map((p) => p.employee_id),
    ...discordPlacements.map((p) => p.employee_id),
  ]);
  const unassignedEmployeeCount = employees.filter(
    (e) => !managerEmployeeIds.has(e.id) && !placedSomewhereIds.has(e.id),
  ).length;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Network}
          accent="cyan"
          title="Employee Board"
          subtitle={
            <>
              Organize the team into workspace groups (and discord
              servers, in their own section below) and tag each person
              with roles. Drag a card between columns to move; drop on
              another card to reorder. Use &ldquo;Add member&rdquo; on a
              section to place the same person in multiple sections.
            </>
          }
        />
      </PageHero>

      <FadeIn>
        <EmployeeBoard
          cards={allCards}
          workspaces={workspaceList}
          managers={managerCards}
          managerCandidates={managerCandidates}
          placeableEmployees={placeableEmployees}
          discordServers={discordServerList}
          discordCards={discordPlacementCards}
          unassignedEmployeeCount={unassignedEmployeeCount}
        />
      </FadeIn>
    </div>
  );
}
