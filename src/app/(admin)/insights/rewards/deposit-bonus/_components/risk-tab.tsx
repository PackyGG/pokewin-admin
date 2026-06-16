import Link from "next/link";
import {
  Trophy,
  Shield,
  AlertTriangle,
  UserX,
  Fingerprint,
  Activity,
  Users,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCurrency,
  formatDateTime,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import {
  getDepositBonusTopSpenders,
  type DepositBonusTopSpender,
} from "@/lib/queries/insights-rewards/deposit-bonus/top-spenders";
import {
  getDepositBonusSuspicious,
  type DepositBonusSuspicious,
} from "@/lib/queries/insights-rewards/deposit-bonus/suspicious";
import {
  compareDepositBonusTopSpenders,
  compareDepositBonusSuspicious,
} from "@/lib/clickhouse/compare/deposit-bonus-risk";
import { getDepositBonusTopSpendersFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/deposit-bonus/top-spenders";
import { getDepositBonusSuspiciousFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/deposit-bonus/suspicious";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Top spenders + risk surveillance tab.
 *
 *   - Top 25 bonus recipients — links to /users/[id], with lifetime
 *     bonus, deposit, wager, and window-PnL columns.
 *   - Suspicious claimants — three signal lists side-by-side:
 *       · withdrew within 24h of bonus (no wager in between)
 *       · claimed bonus, zero wager in window
 *       · sharing a fingerprint visitor_id with another claimant
 *         (alt-farming candidate)
 *
 * Each signal list is bounded to top 25 by signal strength. Per the
 * CLAUDE.md "no sensitive details to client" rule we surface only
 * what's needed to act on the signal — usernames, amounts, dates.
 *
 * House-POV: bonus volume + payouts → rose. wager → emerald.
 */
export async function RiskTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  // Each query is statement-timeout bounded (REWARD_QUERY_TIMEOUT_MS) so a
  // pathological scan degrades to its own fallback tile instead of hanging
  // the segment — the suspicious-claimant cash-out pairing is the heaviest
  // query on this surface (materialised hash/range join; see suspicious.ts),
  // matching impact-tab.tsx / cap-tab.tsx / cohorts-tab.tsx.
  const [topRes, suspiciousRes] = await Promise.all([
    safeQuery(
      () =>
        resolveAdminRead<DepositBonusTopSpender[]>(
          "insights_deposit_bonus_top_spenders",
          {
            pg: () => getDepositBonusTopSpenders(period),
            ch: async () =>
              getDepositBonusTopSpendersFromClickHouse(
                period,
                await getExcludedUserIds(),
              ),
            compare: (pg) => void compareDepositBonusTopSpenders(period, pg),
          },
        ),
      [],
      "insights-rewards-deposit-bonus.top",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () =>
        resolveAdminRead<DepositBonusSuspicious>(
          "insights_deposit_bonus_suspicious",
          {
            pg: () => getDepositBonusSuspicious(period),
            ch: async () =>
              getDepositBonusSuspiciousFromClickHouse(
                period,
                await getExcludedUserIds(),
              ),
            compare: (pg) => void compareDepositBonusSuspicious(period, pg),
          },
        ),
      null,
      "insights-rewards-deposit-bonus.suspicious",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  if (topRes.error) {
    return (
      <TileErrorFallback
        label="Deposit Bonus — Top recipients"
        hint="The top-spenders query failed."
        size="panel"
      />
    );
  }
  const top = topRes.data;
  const suspicious = suspiciousRes.data;
  const label = insightsRewardsPeriodLabel(period);

  if (top.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Trophy}
          title={`No bonus recipients in ${label.toLowerCase()}`}
          description="No claimants in window — nothing to rank."
          compact
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* — Section 1: Top 25 spenders — */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Trophy}
            title="Top 25 bonus recipients"
          />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <TopSpendersTable rows={top} />
          </div>
        </div>
      </FadeIn>

      {/* — Section 2: Suspicious claimants — */}
      {suspicious && (
        <FadeIn>
          <div className="space-y-3">
            <SectionHeading
              icon={Shield}
              title="Suspicious claimant signals"
            />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <KpiTile
                label="Withdrew after bonus"
                value={formatNumber(suspicious.withdrewAfterBonus.length)}
                sub="bonus → withdrawal in 24h, no wager between"
                icon={UserX}
                accent="rose"
              />
              <KpiTile
                label="No wager after bonus"
                value={formatNumber(suspicious.noWager.length)}
                sub="claimed bonus, no wager activity"
                icon={Activity}
                accent="amber"
              />
              <KpiTile
                label="Shared fingerprints"
                value={formatNumber(suspicious.sharedFingerprint.length)}
                sub="visitor_id groups w/ 2+ claimants"
                icon={Fingerprint}
                accent="amber"
              />
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
              <div className="space-y-3">
                <SectionHeading
                  icon={UserX}
                  title="Cash-out abuse candidates"
                />
                <div className="surface-sheen relative overflow-hidden rounded-2xl border border-rose-500/20 bg-rose-500/[0.04] p-4 sm:p-5">
                  {suspicious.withdrewAfterBonus.length > 0 ? (
                    <WithdrewAfterBonusTable
                      rows={suspicious.withdrewAfterBonus}
                    />
                  ) : (
                    <EmptyState
                      icon={Shield}
                      title="No cash-out abuse detected"
                      description="No bonus → withdrawal pattern within 24h."
                      compact
                    />
                  )}
                </div>
              </div>

              <div className="space-y-3">
                <SectionHeading
                  icon={Activity}
                  title="Bonus parked — no wager"
                />
                <div className="surface-sheen relative overflow-hidden rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4 sm:p-5">
                  {suspicious.noWager.length > 0 ? (
                    <NoWagerTable rows={suspicious.noWager} />
                  ) : (
                    <EmptyState
                      icon={Shield}
                      title="No idle bonuses"
                      description="Every claimant in window has wagered."
                      compact
                    />
                  )}
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <SectionHeading
                icon={Fingerprint}
                title="Shared fingerprint clusters"
              />
              <div className="surface-sheen relative overflow-hidden rounded-2xl border border-amber-500/20 bg-amber-500/[0.04] p-4 sm:p-5">
                {suspicious.sharedFingerprint.length > 0 ? (
                  <SharedFingerprintTable
                    rows={suspicious.sharedFingerprint}
                  />
                ) : (
                  <EmptyState
                    icon={Shield}
                    title="No shared fingerprints"
                    description="No visitor_id matches between claimants in window."
                    compact
                  />
                )}
              </div>
            </div>
          </div>
        </FadeIn>
      )}
    </div>
  );
}

// ─── Tables ────────────────────────────────────────────────────────

function TopSpendersTable({
  rows,
}: {
  rows: Array<{
    userId: string;
    username: string | null;
    bonusTotal: number;
    bonusCount: number;
    lifetimeBonusTotal: number;
    lifetimeBonusCount: number;
    depositTotal: number;
    wagerTotal: number;
    payoutTotal: number;
    pnlInWindow: number;
  }>;
}) {
  return (
    <>
      {/* Mobile cards */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r, i) => (
          <div
            key={r.userId}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5"
          >
            <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
              #{i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <Link
                href={`/users/${r.userId}`}
                className="block truncate text-sm font-medium hover:underline"
              >
                {r.username ?? r.userId.slice(0, 8)}
              </Link>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatNumber(r.bonusCount)} bonus · {formatCurrency(r.wagerTotal)} wager
              </span>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(r.bonusTotal)}
              </p>
              <p
                className={cn(
                  "text-[10px] tabular-nums",
                  r.pnlInWindow >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {r.pnlInWindow >= 0 ? "+" : "−"}
                {formatCurrency(Math.abs(r.pnlInWindow))}
              </p>
            </div>
          </div>
        ))}
      </div>
      {/* Desktop */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">Rank</TableHead>
              <TableHead>User</TableHead>
              <TableHead className="text-right">Bonus</TableHead>
              <TableHead className="text-right">Count</TableHead>
              <TableHead className="text-right">Lifetime bonus</TableHead>
              <TableHead className="text-right">Deposit (win)</TableHead>
              <TableHead className="text-right">Wager (win)</TableHead>
              <TableHead className="text-right">GGR (win)</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.userId}>
                <TableCell className="tabular-nums text-muted-foreground">
                  #{i + 1}
                </TableCell>
                <TableCell className="font-medium">
                  <Link href={`/users/${r.userId}`} className="hover:underline">
                    {r.username ?? r.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.bonusTotal)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(r.bonusCount)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.lifetimeBonusTotal)}
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    ({formatNumber(r.lifetimeBonusCount)})
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.depositTotal)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(r.wagerTotal)}
                </TableCell>
                <TableCell
                  className={cn(
                    "text-right tabular-nums",
                    r.pnlInWindow >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400",
                  )}
                >
                  {r.pnlInWindow >= 0 ? "+" : "−"}
                  {formatCurrency(Math.abs(r.pnlInWindow))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

function WithdrewAfterBonusTable({
  rows,
}: {
  rows: Array<{
    userId: string;
    username: string | null;
    bonusInWindow: number;
    bonusCount: number;
    withdrawAmount: number;
    hoursToWithdraw: number;
    withdrewAt: string;
  }>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead className="text-right">Bonus in win</TableHead>
          <TableHead className="text-right">Withdrew</TableHead>
          <TableHead className="text-right">Hours after</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.userId}>
            <TableCell className="font-medium">
              <Link href={`/users/${r.userId}`} className="hover:underline">
                {r.username ?? r.userId.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.bonusInWindow)}
              <span className="ml-1 text-[10px] text-muted-foreground">
                ({formatNumber(r.bonusCount)}×)
              </span>
            </TableCell>
            <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
              <AlertTriangle className="mr-1 inline size-3 text-rose-500" />
              {formatCurrency(r.withdrawAmount)}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {r.hoursToWithdraw.toFixed(1)}h
            </TableCell>
            <TableCell className="tabular-nums text-muted-foreground">
              {formatRelative(r.withdrewAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function NoWagerTable({
  rows,
}: {
  rows: Array<{
    userId: string;
    username: string | null;
    bonusInWindow: number;
    bonusCount: number;
    hasEverWagered: boolean;
    lastBonusAt: string;
  }>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>User</TableHead>
          <TableHead className="text-right">Bonus in win</TableHead>
          <TableHead>Ever wagered?</TableHead>
          <TableHead>Last bonus</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.userId}>
            <TableCell className="font-medium">
              <Link href={`/users/${r.userId}`} className="hover:underline">
                {r.username ?? r.userId.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.bonusInWindow)}
              <span className="ml-1 text-[10px] text-muted-foreground">
                ({formatNumber(r.bonusCount)}×)
              </span>
            </TableCell>
            <TableCell>
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
                  r.hasEverWagered
                    ? "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400",
                )}
              >
                {r.hasEverWagered ? "Yes (ever)" : "Never"}
              </span>
            </TableCell>
            <TableCell className="tabular-nums text-muted-foreground">
              {formatDateTime(r.lastBonusAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function SharedFingerprintTable({
  rows,
}: {
  rows: Array<{
    visitorId: string;
    userCount: number;
    sampleUserIds: string[];
    sampleUsernames: Array<string | null>;
    bonusInWindow: number;
  }>;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Visitor ID</TableHead>
          <TableHead className="text-right">User count</TableHead>
          <TableHead className="text-right">Total bonus</TableHead>
          <TableHead>Sample users (up to 5)</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.visitorId}>
            <TableCell className="font-mono text-[11px] text-muted-foreground">
              {r.visitorId.slice(0, 10)}…
            </TableCell>
            <TableCell className="text-right tabular-nums">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
                  r.userCount > 3
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
                )}
              >
                <Users className="size-3" />
                {r.userCount}
              </span>
            </TableCell>
            <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.bonusInWindow)}
            </TableCell>
            <TableCell>
              <div className="flex flex-wrap gap-1">
                {r.sampleUserIds.slice(0, 5).map((uid, i) => (
                  <Link
                    key={uid}
                    href={`/users/${uid}`}
                    className="rounded-md border bg-muted/30 px-1.5 py-0.5 text-[11px] hover:bg-accent hover:underline"
                  >
                    {r.sampleUsernames[i] ?? uid.slice(0, 8)}
                  </Link>
                ))}
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
