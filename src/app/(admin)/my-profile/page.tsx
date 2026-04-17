import { redirect } from "next/navigation";
import { requireRole } from "@/lib/dal";
import { getMyProfileData } from "@/lib/queries/my-profile";
import { refreshStaleSocials } from "@/lib/queries/creators";
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
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { AFFILIATE_LEVEL_COLORS, AFFILIATE_LEVEL_LABELS } from "@/lib/constants";
import { SocialsCard } from "./socials-card";
import { CreatorWebhooksCard } from "./webhooks-card";
import { DealsTable } from "./deal-detail-dialog";

export const metadata = { title: "My Profile" };

export default async function MyProfilePage() {
  const session = await requireRole(["creator"]);
  const data = await getMyProfileData(session.userId);

  if (!data) redirect("/login");

  // Refresh stale social stats in the background (non-blocking)
  refreshStaleSocials(data.userId).catch(() => {});

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-page-title">{data.username ?? data.email}</h1>
          {data.code && <Badge variant="outline" className="font-mono">{data.code}</Badge>}
          <Badge variant="outline" className={AFFILIATE_LEVEL_COLORS[data.level] ?? ""}>
            {AFFILIATE_LEVEL_LABELS[data.level] ?? `Level ${data.level}`}
          </Badge>
        </div>
        <p className="text-description">{data.email}</p>
        {!data.linked && (
          <p className="mt-2 text-sm text-yellow-500">
            Account not linked to the main site yet. Affiliate stats will appear once linked by an admin.
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Referred" value={formatNumber(data.totalReferred)} />
        <StatCard label="Wager Volume" value={formatCurrency(data.totalWagerVolumeUsd)} />
        <StatCard label="Total Earned" value={formatCurrency(data.totalEarnedUsd)} />
        <StatCard label="Available" value={formatCurrency(data.availableUsd)} />
        <StatCard label="Paid Out" value={formatCurrency(data.totalPaidOutUsd)} />
        <StatCard label="Bonus Distributed" value={formatCurrency(data.totalBonusDistributedUsd)} />
        <StatCard label="Total Clicks" value={formatNumber(data.totalClicks)} />
        <StatCard label="Last Payout" value={data.lastPayoutAt ? formatDateTime(data.lastPayoutAt) : "Never"} />
      </div>

      <SocialsCard socials={data.socials} />

      <Tabs defaultValue="webhooks">
        <TabsList>
          <TabsTrigger value="webhooks">Webhooks ({data.webhooks.length})</TabsTrigger>
          <TabsTrigger value="referrals">Referrals ({data.referrals.length})</TabsTrigger>
          <TabsTrigger value="payouts">Payouts ({data.payouts.length})</TabsTrigger>
          <TabsTrigger value="deals">Deals ({data.deals.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="webhooks">
          <CreatorWebhooksCard webhooks={data.webhooks} />
        </TabsContent>

        <TabsContent value="referrals">
          <Card>
            <CardContent className="pt-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Deposit</TableHead>
                    <TableHead>Wager</TableHead>
                    <TableHead>Your Cut</TableHead>
                    <TableHead>User Bonus</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.referrals.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{r.referredUsername ?? r.referredUserId.slice(0, 8)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.usageType}</Badge>
                      </TableCell>
                      <TableCell>{formatCurrency(r.depositAmountUsd)}</TableCell>
                      <TableCell>{formatCurrency(r.wagerAmountUsd)}</TableCell>
                      {/* Creator's own cut is still HOUSE-POV throughout
                          the admin panel (CLAUDE.md: "STRIKT, keine
                          Ausnahmen") — every dollar the creator earned
                          is a dollar we paid out, so rose. */}
                      <TableCell className="text-rose-600 dark:text-rose-400">
                        {formatCurrency(r.referrerCutUsd)}
                      </TableCell>
                      <TableCell>{formatCurrency(r.userBonusUsd)}</TableCell>
                      <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                  {data.referrals.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                        No referrals yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
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
                      {/* Affiliate payout amount → house paid the
                          creator → house loss → rose. */}
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
          <DealsTable deals={data.deals} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent>
        <p className="text-stat-label">{label}</p>
        <p className="text-stat-value">{value}</p>
      </CardContent>
    </Card>
  );
}
