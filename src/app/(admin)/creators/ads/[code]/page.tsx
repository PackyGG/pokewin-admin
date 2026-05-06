import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowDownToLine,
  ArrowLeft,
  Coins,
  Flag,
  Globe,
  History,
  Megaphone,
  MousePointerClick,
  Percent,
  UserPlus,
  Users,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { KpiTile, PageHero, SectionHeading } from "@/components/modern-panels";
import { Badge } from "@/components/ui/badge";
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
import {
  SETTINGS_KEYS,
  getAdminSetting,
} from "@/lib/admin-settings";
import { getAdCodeDetail } from "@/lib/queries/ads";
import { ClicksByDayChart } from "./charts";
import { CopyShareLink } from "./copy-link";

export const metadata = { title: "Ad Code Detail" };

export default async function AdCodeDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await requirePageAccess("/creators/ads");
  const { code } = await params;
  const decoded = decodeURIComponent(code);

  const houseUserId = await getAdminSetting(SETTINGS_KEYS.HOUSE_AFFILIATE_USER_ID);
  if (!houseUserId) notFound();

  const detail = await getAdCodeDetail(houseUserId, decoded);
  if (!detail) notFound();

  const { summary, clicksByDay, clicksByCountry, signupsList, usageHistory } =
    detail;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Link
              href="/creators/ads"
              className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
              aria-label="Back to Ads"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 shrink-0">
              <Megaphone className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold font-mono leading-tight truncate">
                  {summary.code}
                </h1>
                <Badge
                  variant="outline"
                  className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
                >
                  Ad code
                </Badge>
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Created {formatRelative(summary.createdAt)} ·{" "}
                {formatDateTime(summary.createdAt)}
              </p>
            </div>
          </div>
          <div className="w-full md:w-[360px] shrink-0">
            <CopyShareLink code={summary.code} />
          </div>
        </div>
      </PageHero>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Clicks"
          value={formatNumber(summary.clicks)}
          icon={MousePointerClick}
          accent="blue"
        />
        {/* Signups = unique users with usage_type='signup' on this code
            (canonical from affiliate_code_usages). Sub line shows how
            many of them later deposited or wagered, so a code with lots
            of signups but no activity is visible at a glance. */}
        <KpiTile
          label="Signups"
          value={formatNumber(summary.signups)}
          sub={`${formatNumber(summary.activeReferrals)} active`}
          icon={UserPlus}
          accent="cyan"
        />
        {/* Depositors = unique users who made any deposit booked to
            this ad code (from ledger.deposit_bonus events). Subtitle
            shows total deposit event count, since one user often makes
            many deposits — both numbers matter for ad performance. */}
        <KpiTile
          label="Depositors"
          value={formatNumber(summary.depositors)}
          sub={`${formatNumber(summary.depositEventCount)} deposits`}
          icon={Users}
          accent="emerald"
        />
        <KpiTile
          label="Conversion"
          value={
            summary.clicks > 0
              ? `${(summary.conversionRate * 100).toFixed(2)}%`
              : "—"
          }
          sub="signups / clicks"
          icon={Percent}
          accent="amber"
        />
        {/* Deposits = real volume from ledger (every deposit booked
            to this code). FTD subtitle shows the first-deposit slice
            from affiliate_code_usages, since that's still the headline
            number elsewhere. */}
        <KpiTile
          label="Deposits"
          value={formatCurrency(summary.depositVolumeUsd)}
          sub={`FTD ${formatCurrency(summary.ftdVolumeUsd)}`}
          icon={ArrowDownToLine}
          accent="purple"
        />
        <KpiTile
          label="Wagers"
          value={formatCurrency(summary.wagerVolumeUsd)}
          icon={Coins}
          accent="pink"
        />
      </div>

      {/* Clicks over time */}
      <ClicksByDayChart data={clicksByDay} />

      {/* Geography + Signups — side by side on wide screens */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <SectionHeading icon={Globe} title="Top countries" />
          <div className="rounded-2xl border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Country</TableHead>
                  <TableHead className="text-right">Clicks</TableHead>
                  <TableHead className="text-right">% of total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clicksByCountry.map((c) => {
                  const pct =
                    summary.clicks > 0 ? (c.clicks / summary.clicks) * 100 : 0;
                  return (
                    <TableRow key={c.country}>
                      <TableCell>
                        <span className="inline-flex items-center gap-2">
                          <Flag className="size-3.5 text-muted-foreground" />
                          {c.country || "Unknown"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(c.clicks)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {pct.toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  );
                })}
                {clicksByCountry.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      No clicks yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        {/* Signups & Activity — answers "where is the wager / deposit
            volume coming from?" The list is sorted by wagered desc,
            then deposited desc, so the users actually moving the
            numbers surface at the top instead of being buried under
            tire-kickers who never bet. House-POV colors: deposits
            and wagers are emerald (money flowing IN to the house). */}
        <div className="space-y-3">
          <SectionHeading
            icon={UserPlus}
            title={`Signups & Activity (${formatNumber(signupsList.length)})`}
          />
          <div className="rounded-2xl border overflow-hidden overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead className="text-right">Deposited</TableHead>
                  <TableHead className="text-right">Wagered</TableHead>
                  <TableHead>FTD</TableHead>
                  <TableHead>Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {signupsList.map((s) => {
                  const isActive =
                    s.totalDepositedUsd > 0 || s.totalWageredUsd > 0;
                  return (
                    <TableRow key={s.userId}>
                      <TableCell>
                        <Link
                          href={`/users/${s.userId}`}
                          className="font-medium hover:underline"
                        >
                          {s.username ?? s.email ?? s.userId.slice(0, 8)}
                        </Link>
                        {s.email && s.username && (
                          <p className="text-xs text-muted-foreground truncate">
                            {s.email}
                          </p>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.totalDepositedUsd > 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            {formatCurrency(s.totalDepositedUsd)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {s.totalWageredUsd > 0 ? (
                          <span className="text-emerald-600 dark:text-emerald-400">
                            {formatCurrency(s.totalWageredUsd)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            s.isFtd
                              ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                              : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                          }
                        >
                          {s.isFtd ? "Yes" : "No"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatRelative(s.createdAt)}
                        {!isActive && (
                          <p className="text-[10px] text-muted-foreground/60">
                            no activity
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
                {signupsList.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="h-24 text-center text-sm text-muted-foreground"
                    >
                      No signups yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
          {signupsList.length >= 100 && (
            <p className="text-xs text-muted-foreground">
              Showing 100 most active signups (sorted by wagered, then
              deposited).
            </p>
          )}
        </div>
      </div>

      {/* Code Usage History — every user who has used this code in
          any usage_type (signup, deposit, wager, etc.), aggregated
          per (code, user). Sorted by attributed wager DESC so the
          users actually moving the code's wager-volume KPI surface
          first. Answers "where did the $X wager come from?"
          unambiguously: the rows at the top are the ones with the
          attribution. */}
      <div className="space-y-3">
        <SectionHeading
          icon={History}
          title={`Code Usage History (${formatNumber(usageHistory.length)})`}
        />
        <p className="text-xs text-muted-foreground">
          Every user who&apos;s touched this code — including users
          whose backend-attributed wager / deposit shows up in the
          KPI strip even though they never appeared as a signup.
          Sorted by attributed wager (highest first).
        </p>
        <div className="rounded-2xl border overflow-hidden overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Used as</TableHead>
                <TableHead className="text-right">Attr. Wager</TableHead>
                <TableHead className="text-right">Attr. Deposit</TableHead>
                <TableHead className="text-right">Lifetime Wager</TableHead>
                <TableHead className="text-right">Uses</TableHead>
                <TableHead>Last Used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usageHistory.map((u) => (
                <TableRow key={u.userId}>
                  <TableCell>
                    <Link
                      href={`/users/${u.userId}`}
                      className="font-medium hover:underline"
                    >
                      {u.username ?? u.email ?? u.userId.slice(0, 8)}
                    </Link>
                    {u.email && u.username && (
                      <p className="text-xs text-muted-foreground truncate">
                        {u.email}
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.usageTypes.length === 0 ? (
                        <span className="text-xs text-muted-foreground">
                          —
                        </span>
                      ) : (
                        u.usageTypes.map((t) => (
                          <Badge
                            key={t}
                            variant="outline"
                            className="text-[10px] capitalize"
                          >
                            {t.replace(/_/g, " ")}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {u.attributedWagerUsd > 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(u.attributedWagerUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {u.attributedDepositUsd > 0 ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(u.attributedDepositUsd)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </TableCell>
                  {/* Lifetime wager (from balances) gives context: a
                      user with $50 attributed wager but $5,000 lifetime
                      wager is wagering elsewhere too. */}
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {u.lifetimeWageredUsd > 0
                      ? formatCurrency(u.lifetimeWageredUsd)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatNumber(u.usageCount)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatRelative(u.lastUsedAt)}
                  </TableCell>
                </TableRow>
              ))}
              {usageHistory.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="h-24 text-center text-sm text-muted-foreground"
                  >
                    No usage history yet — no clicks have converted into
                    a recorded usage row.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {usageHistory.length >= 100 && (
          <p className="text-xs text-muted-foreground">
            Showing 100 users with the highest attributed wager.
          </p>
        )}
      </div>
    </div>
  );
}
