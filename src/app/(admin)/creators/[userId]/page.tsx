import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCreatorDetail, getCreatorTips, refreshStaleSocials } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { AFFILIATE_LEVEL_COLORS, AFFILIATE_LEVEL_LABELS } from "@/lib/constants";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { CreatorPayoutButton } from "./payout-button";
import { LevelSelect } from "./level-select";
import { CodesCard } from "./codes-card";
import { LimitsCard } from "./limits-card";
import { RoleSelect } from "./role-select";
import { WebhooksCard } from "./webhooks-card";
import { DealsCard } from "./deals-card";
import { SocialsDisplay } from "./socials-display";
import { OverviewCard } from "./overview-card";

export const metadata = { title: "Creator Detail" };

export default async function CreatorDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators");
  const { userId } = await params;
  const sp = await searchParams;
  const page = Number(sp.page) || 1;
  const perPage = Number(sp.perPage) || 20;
  const [data, tips] = await Promise.all([
    getCreatorDetail(userId, page, perPage),
    getCreatorTips(userId, page, perPage),
  ]);

  if (!data) notFound();

  // Refresh stale social stats in the background (non-blocking)
  refreshStaleSocials(userId).catch(() => {});

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/creators" className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <Link href={`/users/${data.userId}`} className="text-page-title hover:underline">
              {data.username ?? data.email}
            </Link>
            <RoleSelect userId={data.userId} currentRole={data.role} />
            <Badge variant="outline" className="font-mono">{data.code}</Badge>
            <LevelSelect userId={data.userId} currentLevel={data.level} />
          </div>
          <p className="text-description">{data.email}</p>
        </div>
        <CreatorPayoutButton affiliateUserId={data.userId} availableUsd={data.availableUsd} />
      </div>

      <OverviewCard
        deals={data.deals}
        socials={data.socials}
        availableUsd={data.availableUsd}
        totalPaidOutUsd={data.totalPaidOutUsd}
      />

      {/* Acquisition funnel: clicks → signups → depositors (Referred).
          totalReferred only counts users who hit a usage event
          (deposit/wager); signups includes every attributed registration. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Clicks" value={formatNumber(data.totalClicks)} />
        <StatCard
          label="Signups"
          value={formatNumber(data.signups.total)}
          subtitle={`+${data.signups.last24h} 24h · +${data.signups.last7d} 7d · +${data.signups.last30d} 30d${data.signups.pending > 0 ? ` · ${data.signups.pending} pending` : ""}`}
        />
        <StatCard
          label="Depositors"
          value={formatNumber(data.totalReferred)}
          subtitle={
            data.signups.total > 0
              ? `${((data.totalReferred / data.signups.total) * 100).toFixed(1)}% conversion`
              : undefined
          }
        />
        <StatCard label="Wager Volume" value={formatCurrency(data.totalWagerVolumeUsd)} />
        <StatCard label="Total Earned" value={formatCurrency(data.totalEarnedUsd)} />
        <StatCard label="Available" value={formatCurrency(data.availableUsd)} />
        <StatCard label="Paid Out" value={formatCurrency(data.totalPaidOutUsd)} />
        <StatCard label="Bonus Distributed" value={formatCurrency(data.totalBonusDistributedUsd)} />
      </div>

      {/* Platform PnL */}
      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex items-baseline justify-between">
            <p className="text-card-title font-semibold">Platform PnL</p>
            <p className={cn("text-2xl font-bold", data.pnl.truePlatformPnl >= 0 ? "text-green-500" : "text-red-500")}>
              {formatCurrency(data.pnl.truePlatformPnl)}
            </p>
          </div>
          <div className="mb-5 flex gap-6 text-sm text-muted-foreground">
            <span>Referral GGR: <span className="text-foreground font-medium">{formatCurrency(data.pnl.totalGgr)}</span></span>
            <span>Referral Costs: <span className="text-foreground font-medium">{formatCurrency(data.pnl.totalCosts)}</span></span>
            <span>Creator Cost: <span className="text-foreground font-medium">{formatCurrency(data.pnl.creatorCost)}</span></span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[100px]">Period</TableHead>
                {data.pnl.byPeriod.map((p) => (
                  <TableHead key={p.period} className="text-right">{p.period}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="font-medium">GGR</TableCell>
                {data.pnl.byPeriod.map((p) => (
                  <TableCell key={p.period} className="text-right">{formatCurrency(p.ggr)}</TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Costs</TableCell>
                {data.pnl.byPeriod.map((p) => (
                  <TableCell key={p.period} className="text-right">{formatCurrency(p.costs)}</TableCell>
                ))}
              </TableRow>
              <TableRow>
                <TableCell className="font-medium">Net PnL</TableCell>
                {data.pnl.byPeriod.map((p) => (
                  <TableCell key={p.period} className={cn("text-right font-semibold", p.netPnl >= 0 ? "text-green-500" : "text-red-500")}>
                    {formatCurrency(p.netPnl)}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <SocialsDisplay socials={data.socials} userId={data.userId} />

      <Tabs defaultValue="settings">
        <TabsList>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="referrals">Referrals ({data.referrals.total})</TabsTrigger>
          <TabsTrigger value="tips">Tips ({tips.total})</TabsTrigger>
          <TabsTrigger value="payouts">Payouts ({data.payouts.length})</TabsTrigger>
          <TabsTrigger value="deals">Deals ({data.deals.length})</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks ({data.webhooks.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="space-y-4">
          <CodesCard
            userId={data.userId}
            primaryCode={data.code}
            codeActive={data.codeActive}
            additionalCodes={data.additionalCodes}
          />
          <LimitsCard userId={data.userId} limits={data.limits} />
        </TabsContent>

        <TabsContent value="referrals" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
            {(["1d", "3d", "7d", "14d", "30d", "all"] as const).map((period) => (
              <Card key={period}>
                <CardContent>
                  <p className="text-stat-label">FTDs ({period === "all" ? "All Time" : period})</p>
                  <p className="text-stat-value">{formatNumber(data.ftdByPeriod[period])}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>FTD</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Deposit</TableHead>
                    <TableHead>Wager</TableHead>
                    <TableHead>Referrer Cut</TableHead>
                    <TableHead>User Bonus</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.referrals.data.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Link href={`/users/${r.referredUserId}`} className="hover:underline">
                          {r.referredUsername ?? r.referredUserId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            r.isFtd
                              ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                              : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                          }
                        >
                          {r.isFtd ? "Yes" : "No"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.usageType}</Badge>
                      </TableCell>
                      <TableCell>{formatCurrency(r.depositAmountUsd)}</TableCell>
                      <TableCell>{formatCurrency(r.wagerAmountUsd)}</TableCell>
                      <TableCell className="text-green-400">{formatCurrency(r.referrerCutUsd)}</TableCell>
                      <TableCell>{formatCurrency(r.userBonusUsd)}</TableCell>
                      <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                  {data.referrals.data.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="h-24 text-center text-muted-foreground">
                        No referrals yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <DataTablePagination
                page={data.referrals.page}
                totalPages={data.referrals.totalPages}
                total={data.referrals.total}
                perPage={data.referrals.perPage}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tips" className="space-y-4">
          <Card>
            <CardContent className="pt-6">
              <div className="mb-4 flex items-baseline justify-between">
                <p className="text-sm font-semibold">Rain Tips</p>
                <p className="text-lg font-bold tabular-nums">{formatCurrency(tips.totalTipped)} total</p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Amount</TableHead>
                    <TableHead>Rain Pool</TableHead>
                    <TableHead>Rain Status</TableHead>
                    <TableHead>Winner</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tips.data.map((t) => (
                    <TableRow key={t.id}>
                      <TableCell className="font-medium tabular-nums">{formatCurrency(t.amountUsd)}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">{formatCurrency(t.rainTotalPool)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={
                          t.rainStatus === "completed" ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30" :
                          t.rainStatus === "active" ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30" :
                          "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                        }>
                          {t.rainStatus}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {t.rainWinnerUsername ? (
                          <span className="text-sm">{t.rainWinnerUsername}</span>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDateTime(t.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                  {tips.data.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                        No tips sent yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <DataTablePagination
                page={tips.page}
                totalPages={tips.totalPages}
                total={tips.total}
                perPage={tips.perPage}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="payouts">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.payouts.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{formatCurrency(p.amountUsd)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={
                          p.status === "paid" ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30" :
                          p.status === "failed" ? "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30" :
                          "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                        }>
                          {p.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{formatDateTime(p.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                  {data.payouts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                        No payouts yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="deals">
          <DealsCard userId={data.userId} deals={data.deals} />
        </TabsContent>

        <TabsContent value="webhooks">
          <WebhooksCard userId={data.userId} webhooks={data.webhooks} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({
  label,
  value,
  subtitle,
}: {
  label: string;
  value: string;
  subtitle?: string;
}) {
  return (
    <Card>
      <CardContent>
        <p className="text-stat-label">{label}</p>
        <p className="text-stat-value">{value}</p>
        {subtitle && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</p>
        )}
      </CardContent>
    </Card>
  );
}

