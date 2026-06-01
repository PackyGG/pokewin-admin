import Link from "next/link";
import { Shuffle, Trophy, Users, ChevronRight } from "lucide-react";
import {
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FadeIn } from "@/components/fade-in";
import { formatNumber, formatCurrency } from "@/lib/utils/format";
import { getCodeSwitchers } from "@/lib/queries/insights-streamers/code-switching";
import { periodLabel, type StreamerPeriod } from "./types";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Code Switching tab — users who have used 2+ DISTINCT codes lifetime.
 *
 * What "switching" means here: a user has at least one acu row of
 * type 'deposit' or 'wager' under code A and one under code B. The
 * row's chronology column renders the order in which they switched —
 * leaderboard sniping looks like (A → B → A) right around a race
 * window.
 *
 * The "Races claimed" column cross-references race_claims so admins can
 * spot users who used a code, swept a leaderboard, then moved on. The
 * dedicated Leaderboard Sniper tab does the same correlation per
 * race-claim — this tab is the per-user view.
 */
export async function CodeSwitchingTab({ period }: { period: StreamerPeriod }) {
  const { data: rows, error } = await safeQuery(
    () => getCodeSwitchers(period),
    [] as Awaited<ReturnType<typeof getCodeSwitchers>>,
    "insights-streamers.codeSwitching",
  );
  if (error) {
    return (
      <TileErrorFallback
        label="Streamers — Code Switching"
        hint="The code-switching query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const withRace = rows.filter((r) => r.raceClaimCount > 0).length;
  const totalCodes = rows.reduce((acc, r) => acc + r.codeCount, 0);
  const avgCodes = rows.length > 0 ? totalCodes / rows.length : 0;
  const totalWager = rows.reduce((acc, r) => acc + r.totalWagerUsd, 0);

  return (
    <div className="space-y-6">
      <FadeIn>
        <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
          <KpiTile
            label="Switchers"
            value={formatNumber(rows.length)}
            sub={`with activity in ${periodLabel(period).toLowerCase()}`}
            icon={Shuffle}
            accent="purple"
          />
          <KpiTile
            label="Race Claimers"
            value={formatNumber(withRace)}
            sub="Won a race + switched code"
            icon={Trophy}
            accent="amber"
          />
          <KpiTile
            label="Avg Codes / User"
            value={avgCodes.toFixed(1)}
            sub="Across the switcher set"
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Cohort Wager"
            value={formatCurrency(totalWager)}
            sub="By switchers in window"
            icon={Trophy}
            accent="emerald"
          />
        </div>
      </FadeIn>

      <FadeIn delay={75}>
        <SectionHeading
          icon={Shuffle}
          title={`Code Switchers — ${periodLabel(period)}`}
        />
        <div className="surface-sheen surface-raise rounded-xl border bg-card mt-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Codes Used</TableHead>
                <TableHead>Code Chronology</TableHead>
                <TableHead className="text-right">Wager</TableHead>
                <TableHead className="text-right">Deposits</TableHead>
                <TableHead className="text-right">Race Wins</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No multi-code users in this window.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.userId}>
                    <TableCell>
                      <Link
                        href={`/users/${r.userId}`}
                        className="font-medium hover:underline"
                      >
                        {r.username ?? r.email ?? r.userId.slice(0, 8)}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(r.codeCount)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        {r.codeChronology.map((c, idx) => (
                          <span key={`${c.code}-${idx}`} className="inline-flex items-center gap-1">
                            <span
                              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs"
                              title={
                                c.ownerUsername
                                  ? `${c.ownerUsername} • ${c.firstUsedAt}`
                                  : `Unknown owner • ${c.firstUsedAt}`
                              }
                            >
                              <code>{c.code}</code>
                              {c.ownerUsername && (
                                <span className="text-[10px] text-muted-foreground">
                                  ({c.ownerUsername})
                                </span>
                              )}
                            </span>
                            {idx < r.codeChronology.length - 1 && (
                              <ChevronRight className="size-3 text-muted-foreground" />
                            )}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(r.totalWagerUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(r.totalDepositsUsd)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.raceClaimCount > 0 ? (
                        <span
                          className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400"
                          title={`Lifetime race claims: ${formatCurrency(r.raceClaimUsd)}`}
                        >
                          <Trophy className="size-3" />
                          {formatNumber(r.raceClaimCount)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </FadeIn>
    </div>
  );
}
