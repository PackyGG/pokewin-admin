import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getCreatorDetail, getCreatorTips, refreshStaleSocials } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { CreatorPayoutButton } from "./payout-button";
import { LevelSelect } from "./level-select";
import { CodesCard } from "./codes-card";
import { LimitsCard } from "./limits-card";
import { RoleSelect } from "./role-select";
import { WebhooksCard } from "./webhooks-card";
import { DealsCard } from "./deals-card";
import { OverviewCard } from "./overview-card";
import { MaskedEmail } from "./masked-email";
import { AcquisitionChart } from "./acquisition-chart";
import { FunnelTable } from "./funnel-table";
import { FinancialsCard } from "./financials-card";
import { CountryBreakdown } from "./country-breakdown";
import { HeaderSocials } from "./header-socials";

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

  // Preview helper: append `?demo=1` to the URL to see how the OverviewCard
  // renders for a creator with a fully-populated active deal. Pure UI
  // visualisation — no DB writes, no impact on any other surface.
  const previewDeals = sp.demo === "1" && data.deals.length === 0
    ? [
        {
          id: "demo-deal",
          dealName: "Sample Streaming Deal",
          dealType: "revenue_share",
          amount: 0,
          currency: "USD",
          startDate: new Date().toISOString(),
          endDate: null,
          status: "active",
          notes: null,
          dailyFillAmount: 500,
          dailyFillTime: null,
          dailyFillEnabled: true,
          keepPercentage: 0.8,
          currencyLimitAmount: 10000,
          currencyLimitResetDays: 30,
          percentageLimit: 0.05,
          tipLimit: 1000,
          tipLimitResetDays: 7,
          leaderboardPrizePool: 0,
          leaderboardOurShare: 0,
          leaderboardFrequency: null,
          minStreamMinutes: null,
          maxFinancialExposure: 50000,
          createdAt: new Date().toISOString(),
        },
      ]
    : data.deals;

  return (
    <div className="space-y-6">
      {/* Flat header — no card chrome / glow orbs. Bottom border separates
          it from the deal summary below; both share the same horizontal
          rhythm so the page reads as one quiet top-section, not two
          stacked decorative cards. */}
      <div className="flex items-center gap-3 pb-4 border-b">
        <Link href="/creators" className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <Avatar className="size-10">
          {data.image && <AvatarImage src={data.image} alt="" />}
          <AvatarFallback className="text-xs font-semibold">
            {(data.username ?? data.email ?? "?").slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Link href={`/users/${data.userId}`} className="text-xl font-semibold hover:underline">
              {data.username ?? data.email}
            </Link>
            <Badge variant="outline" className="font-mono text-[11px]">{data.code}</Badge>
            <span className="text-muted-foreground/40">·</span>
            <RoleSelect userId={data.userId} currentRole={data.role} />
            <LevelSelect userId={data.userId} currentLevel={data.level} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            {data.email && <MaskedEmail email={data.email} />}
            <HeaderSocials socials={data.socials} userId={data.userId} />
          </div>
        </div>
        <CreatorPayoutButton affiliateUserId={data.userId} availableUsd={data.availableUsd} />
      </div>

      <OverviewCard
        deals={previewDeals}
        socials={data.socials}
        availableUsd={data.availableUsd}
        totalPaidOutUsd={data.totalPaidOutUsd}
      />

      {/* Acquisition funnel + financials. Left column: hourly/daily chart
          stacked with the full Clicks→Signups→FTDs period table. Right
          column: compact financials list. Replaces the previous 8 flat
          StatCards — same information, denser and grouped by semantic. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <AcquisitionChart
            hourly={data.acquisition.hourly}
            daily={data.acquisition.daily}
          />
          <FunnelTable
            clicks={data.clicks}
            signups={data.signups}
            ftdByPeriod={data.ftdByPeriod}
          />
        </div>
        <div className="space-y-4">
          <FinancialsCard
            wagerVolumeUsd={data.totalWagerVolumeUsd}
            earnedUsd={data.totalEarnedUsd}
            availableUsd={data.availableUsd}
            paidOutUsd={data.totalPaidOutUsd}
            bonusDistributedUsd={data.totalBonusDistributedUsd}
          />
          <CountryBreakdown rows={data.countryBreakdown} />
        </div>
      </div>

      {/* Platform PnL — already a house-POV figure (positive = house won
          on this creator's cohort). Palette switches to emerald/rose so
          it matches the dashboard and the rest of the site. */}
      <Card>
        <CardContent className="pt-6">
          <div className="mb-4 flex items-baseline justify-between">
            <p className="text-card-title font-semibold">Platform PnL</p>
            <p
              className={cn(
                "text-2xl font-bold",
                data.pnl.truePlatformPnl >= 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-rose-600 dark:text-rose-400",
              )}
            >
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
                  <TableCell
                    key={p.period}
                    className={cn(
                      "text-right font-semibold",
                      p.netPnl >= 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-rose-600 dark:text-rose-400",
                    )}
                  >
                    {formatCurrency(p.netPnl)}
                  </TableCell>
                ))}
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
                      {/* Referrer cut = commission paid by the house to
                          this creator → house loss → rose per CLAUDE.md. */}
                      <TableCell className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.referrerCutUsd)}
                      </TableCell>
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
                      {/* Payout amount = money we sent to the creator.
                          Always a house loss → rose per CLAUDE.md. */}
                      <TableCell className="text-rose-600 dark:text-rose-400 tabular-nums">
                        {formatCurrency(p.amountUsd)}
                      </TableCell>
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

