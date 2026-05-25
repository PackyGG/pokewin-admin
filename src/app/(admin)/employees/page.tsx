import { Network } from "lucide-react";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { ensureEmployeeBoardSchema } from "@/lib/employee-board/ensure-schema";
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

  const [employees, workspaces, placements, managers] = await Promise.all([
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
    adminDb.employee_board_placements.findMany({
      select: {
        employee_id: true,
        workspace_id: true,
        roles: true,
        position: true,
      },
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
  ]);

  // Join in code (no cross-table include needed): each employee → its
  // placement by employee_id. Missing placement or workspace_id=null →
  // the employee lives in the Unassigned pool.
  const placementByEmployee = new Map(
    placements.map((p) => [p.employee_id, p]),
  );

  // Managers are rendered in their own row, so they're excluded from the
  // column cards below. Their column placement/roles are kept untouched
  // in the DB so demoting returns them to where they were.
  const managerEmployeeIds = new Set(managers.map((m) => m.employee_id));
  const employeeById = new Map(employees.map((e) => [e.id, e]));

  const employeeCards = employees
    .filter((e) => !managerEmployeeIds.has(e.id))
    .map((e) => {
      const placement = placementByEmployee.get(e.id);
      return {
        id: e.id,
        discordName: e.discord_name,
        active: e.active,
        workspaceId: placement?.workspace_id ?? null,
        roles: placement?.roles ?? [],
        position: placement?.position ?? 0,
      };
    });

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

  const workspaceList = workspaces.map((w) => ({
    id: w.id,
    name: w.name,
  }));

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Network}
          accent="cyan"
          title="Employee Board"
          subtitle={
            <>
              Organize the team into workspace groups and tag each person
              with roles. Drag a card between columns; double-click a card to
              add a role.
            </>
          }
        />
      </PageHero>

      <FadeIn>
        <EmployeeBoard
          employees={employeeCards}
          workspaces={workspaceList}
          managers={managerCards}
          managerCandidates={managerCandidates}
        />
      </FadeIn>
    </div>
  );
}
