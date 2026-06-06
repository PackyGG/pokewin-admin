import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowDownToLine,
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
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
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
import {
  getAdCodeDetail,
  type AdCodeUsageEntry,
} from "@/lib/queries/ads";
import { EmptyState } from "@/components/empty-state";
import { ClicksByDayChart } from "@/app/(admin)/creators/ads/[code]/charts";
import { CopyShareLink } from "@/app/(admin)/creators/ads/[code]/copy-link";

import { requireCreatorHubPageAccess } from "../../_lib/require-creator-hub-access";

export const metadata = { title: "Ad Code Detail · Creator Hub" };

const HUB_ADS_LIST = "/creator-hub/codes-ads/ads";

export default async function CreatorHubAdCodeDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  await requireCreatorHubPageAccess();
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
        <PageHeroIdentity
          icon={Megaphone}
          accent="pink"
          backHref={HUB_ADS_LIST}
          title={summary.code}
          titleClassName="font-mono truncate"
          badges={
            <Badge
              variant="outline"
              className="bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30"
            >
              Ad code
            </Badge>
          }
          subtitle={
            <>
              Created {formatRelative(summary.createdAt)} ·{" "}
              {formatDateTime(summary.createdAt)}
            </>
          }
          action={
            <div className="w-full md:w-[360px] shrink-0">
              <CopyShareLink code={summary.code} />
            </div>
          }
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Clicks"
          value={formatNumber(summary.clicks)}
          icon={MousePointerClick}
          accent="blue"
        />
        <KpiTile
          label="Signups"
          value={formatNumber(summary.signups)}
          sub={`${formatNumber(summary.activeReferrals)} active`}
          icon={UserPlus}
          accent="cyan"
        />
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

      <WagerSourceSection usageHistory={usageHistory} />

      <ClicksByDayChart data={clicksByDay} />

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
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={3} className="p-0">
                      <EmptyState
                        icon={Globe}
                        title="No clicks yet"
                        description="Country breakdown appears once the tracking link gets its first clicks."
                        compact
                      />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </div>

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
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="p-0">
                      <EmptyState
                        icon={UserPlus}
                        title="No signups yet"
                        description="Users who sign up through this code will show up here with their deposit and wager activity."
                        compact
                      />
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
    </div>
  );
}

function WagerSourceSection({
  usageHistory,
}: {
  usageHistory: AdCodeUsageEntry[];
}) {
  return (
    <div className="space-y-3">
      <SectionHeading
        icon={History}
        title={`Wager Source · ${formatNumber(usageHistory.length)} users`}
      />
      <p className="text-xs text-muted-foreground">
        Every user the backend has attributed activity (wager, deposit, signup)
        on this code to. Sorted by attributed wager DESC, so the rows at the top
        are the ones contributing to the Wagers KPI above.
      </p>
      <div className="rounded-2xl border overflow-hidden overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Used as</TableHead>
              <TableHead className="text-right">Attr. Wager</TableHead>
              <TableHead className="text-right">Attr. Deposit</TableHead>
              <TableHead className="text-right">Won</TableHead>
              <TableHead className="text-right">House P&amp;L</TableHead>
              <TableHead className="text-right">Uses</TableHead>
              <TableHead>Last Used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {usageHistory.map((u) => {
              const housePnl = u.lifetimeWageredUsd - u.lifetimeWonUsd;
              return (
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
                        <span className="text-xs text-muted-foreground">—</span>
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
                      <span className="font-semibold text-emerald-600 dark:text-emerald-400">
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
                  <TableCell className="text-right tabular-nums">
                    {u.lifetimeWonUsd > 0 ? (
                      <div className="flex flex-col items-end leading-tight">
                        <span className="text-rose-600 dark:text-rose-400">
                          {formatCurrency(u.lifetimeWonUsd)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          on {formatCurrency(u.lifetimeWageredUsd)} wagered
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {u.lifetimeWageredUsd > 0 ? (
                      <span
                        className={
                          housePnl >= 0
                            ? "font-semibold text-emerald-600 dark:text-emerald-400"
                            : "font-semibold text-rose-600 dark:text-rose-400"
                        }
                      >
                        {housePnl >= 0 ? "+" : ""}
                        {formatCurrency(housePnl)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatNumber(u.usageCount)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatRelative(u.lastUsedAt)}
                  </TableCell>
                </TableRow>
              );
            })}
            {usageHistory.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0">
                  <EmptyState
                    icon={History}
                    title="No attributed activity yet"
                    description="When a user signs up, deposits, or wagers via this code, the row will appear here."
                    compact
                  />
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
  );
}
