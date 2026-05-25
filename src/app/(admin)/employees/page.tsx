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

  const [employees, workspaces, placements] = await Promise.all([
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
  ]);

  // Join in code (no cross-table include needed): each employee → its
  // placement by employee_id. Missing placement or workspace_id=null →
  // the employee lives in the Unassigned pool.
  const placementByEmployee = new Map(
    placements.map((p) => [p.employee_id, p]),
  );

  const employeeCards = employees.map((e) => {
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
        <EmployeeBoard employees={employeeCards} workspaces={workspaceList} />
      </FadeIn>
    </div>
  );
}
