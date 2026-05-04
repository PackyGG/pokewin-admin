import { Wallet, Coins, Users, Receipt } from "lucide-react";
import { adminDb } from "@/lib/admin-db";
import { requireMotha } from "@/lib/salary/motha-gate";
import { ensureSalarySchema } from "@/lib/salary/ensure-schema";
import { deriveAddress, getWalletSnapshot } from "@/lib/salary/wallet";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { SalariesClient } from "./salaries-client";

export const metadata = { title: "Employee Salaries" };

const WALLET_SINGLETON_ID = "singleton";

export default async function SalariesPage() {
  await requireMotha();
  // Defensive: create the salary tables on first access if the
  // migration hasn't been applied yet. Same self-heal pattern as
  // /shifts. If the DB call below ever throws P2021 ("relation does
  // not exist") this is what's saving us.
  await ensureSalarySchema().catch(() => {
    /* swallow — the queries below will surface a clearer error */
  });

  // Pull every piece in parallel — the on-chain balance call adds
  // ~1-2s; we don't want it serialized behind the DB reads.
  const [wallet, employees, recentPayouts] = await Promise.all([
    adminDb.salary_wallet.findUnique({ where: { id: WALLET_SINGLETON_ID } }),
    adminDb.salary_employees.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
    adminDb.salary_payouts.findMany({
      orderBy: { created_at: "desc" },
      take: 25,
      include: {
        employee: { select: { name: true, eth_address: true } },
      },
    }),
  ]);

  // Wallet snapshot — try chain calls only when a key is set.
  let snapshot:
    | {
        address: string;
        ethBalance: string;
        usdtBalance: string;
      }
    | null = null;
  let snapshotError: string | null = null;
  if (wallet) {
    try {
      const s = await getWalletSnapshot(wallet.private_key, wallet.rpc_url);
      snapshot = {
        address: s.address,
        ethBalance: s.ethBalance,
        usdtBalance: s.usdtBalance,
      };
    } catch (err) {
      // If RPC is unreachable still expose the derived address so
      // the admin can fund the wallet. Balance shows "—".
      snapshot = {
        address: deriveAddress(wallet.private_key),
        ethBalance: "—",
        usdtBalance: "—",
      };
      snapshotError = err instanceof Error ? err.message : "RPC error";
    }
  }

  const activeEmployees = employees.filter((e) => e.active).length;
  const totalMonthlyBudget = employees
    .filter((e) => e.active)
    .reduce((sum, e) => sum + Number(e.salary_usdt), 0);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10">
            <Coins className="size-5 text-amber-500" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">
              Employee Salaries
            </h1>
            <p className="text-sm text-muted-foreground">
              On-chain USDT (ERC-20) payouts to saved employee
              addresses. Admin-only.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Active Employees"
          value={String(activeEmployees)}
          icon={Users}
          accent="cyan"
        />
        <KpiTile
          label="Wallet USDT"
          value={snapshot ? snapshot.usdtBalance : "—"}
          icon={Wallet}
          accent="emerald"
        />
        <KpiTile
          label="Wallet ETH (gas)"
          value={snapshot ? snapshot.ethBalance : "—"}
          icon={Wallet}
          accent="purple"
        />
        <KpiTile
          label="Monthly Budget"
          value={`$${totalMonthlyBudget.toFixed(2)}`}
          icon={Receipt}
          accent="amber"
        />
      </div>

      <FadeIn>
        <SalariesClient
          wallet={
            wallet
              ? {
                  hasKey: true,
                  address: snapshot?.address ?? deriveAddress(wallet.private_key),
                  privateKey: wallet.private_key,
                  rpcUrl: wallet.rpc_url,
                  usdtBalance: snapshot?.usdtBalance ?? "—",
                  ethBalance: snapshot?.ethBalance ?? "—",
                  snapshotError,
                  updatedAt: wallet.updated_at.toISOString(),
                }
              : { hasKey: false }
          }
          employees={employees.map((e) => ({
            id: e.id,
            name: e.name,
            ethAddress: e.eth_address,
            salaryUsdt: Number(e.salary_usdt),
            maxPerPayout: e.max_per_payout ? Number(e.max_per_payout) : null,
            active: e.active,
            lastPaidAt: e.last_paid_at?.toISOString() ?? null,
            notes: e.notes,
          }))}
          payouts={recentPayouts.map((p) => ({
            id: p.id,
            employeeName: p.employee.name,
            amountUsdt: Number(p.amount_usdt),
            toAddress: p.to_address,
            txHash: p.tx_hash,
            status: p.status as
              | "pending"
              | "broadcast"
              | "confirmed"
              | "failed",
            errorMessage: p.error_message,
            broadcastAt: p.broadcast_at?.toISOString() ?? null,
            confirmedAt: p.confirmed_at?.toISOString() ?? null,
            createdAt: p.created_at.toISOString(),
          }))}
        />
      </FadeIn>
    </div>
  );
}
