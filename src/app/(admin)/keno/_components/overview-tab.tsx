import {
  BarChart3,
  Banknote,
  CircleDollarSign,
  Dices,
  Gauge,
  Percent,
  Trophy,
  Users,
} from "lucide-react";

import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  KpiTile,
  PanelRow,
  SectionHeading,
  StatPanel,
} from "@/components/modern-panels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  EMPTY_KENO_DASHBOARD,
  getKenoDashboard,
  type KenoMetricSlice,
} from "@/lib/queries/keno";

const percent = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  }).format(value);

function PeriodPanel({
  title,
  data,
}: {
  title: string;
  data: KenoMetricSlice;
}) {
  return (
    <StatPanel title={title} icon={Gauge} accent="purple">
      <PanelRow label="Games" value={formatNumber(data.games)} />
      <PanelRow label="Players" value={formatNumber(data.players)} />
      <PanelRow label="Wagered" value={formatCurrency(data.wager)} />
      <PanelRow label="Paid" value={formatCurrency(data.payout)} />
      <PanelRow
        label="House GGR"
        value={formatCurrency(data.ggr)}
        valueClassName={
          data.ggr >= 0
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400"
        }
      />
      <PanelRow label="RTP" value={percent(data.rtp)} />
      <PanelRow label="Profitable plays" value={percent(data.profitableRate)} />
    </StatPanel>
  );
}

export async function KenoOverviewTab() {
  const { data, error } = await safeQuery(
    getKenoDashboard,
    EMPTY_KENO_DASHBOARD,
    "keno.overview",
    10_000,
  );

  if (error) {
    return <TileErrorFallback label="Keno statistics" />;
  }

  const lifetime = data.lifetime;

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <SectionHeading
          icon={Dices}
          title="Lifetime performance"
          action={
            <Badge variant="outline" className="font-normal">
              Live data · cached up to 5 minutes
            </Badge>
          }
        />
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiTile
            label="Games"
            value={formatNumber(lifetime.games)}
            sub={`${formatNumber(lifetime.players)} unique players`}
            icon={Dices}
            accent="purple"
          />
          <KpiTile
            label="Wagered"
            value={formatCurrency(lifetime.wager)}
            sub={`${formatCurrency(lifetime.averageBet)} average bet`}
            icon={Banknote}
            accent="blue"
          />
          <KpiTile
            label="Paid"
            value={formatCurrency(lifetime.payout)}
            sub={`${percent(lifetime.cashReturnRate)} received a return`}
            icon={CircleDollarSign}
            accent="rose"
          />
          <KpiTile
            label="House GGR"
            value={formatCurrency(lifetime.ggr)}
            sub={`${percent(lifetime.hold)} realized hold`}
            icon={Trophy}
            accent={lifetime.ggr >= 0 ? "emerald" : "rose"}
          />
          <KpiTile
            label="RTP"
            value={percent(lifetime.rtp)}
            sub="Realized · configured ≈92.5%"
            icon={Percent}
            accent="cyan"
          />
          <KpiTile
            label="Best payout"
            value={formatCurrency(lifetime.maxPayout)}
            sub={`${lifetime.maxMultiplier.toFixed(2)}× highest multiplier`}
            icon={Users}
            accent="amber"
          />
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <PeriodPanel title="Last 24 hours" data={data.last24Hours} />
        <PeriodPanel title="Last 7 days" data={data.last7Days} />
      </div>

      <section className="space-y-3">
        <SectionHeading icon={Gauge} title="Performance by risk mode" />
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Risk</TableHead>
                <TableHead className="text-right">Games</TableHead>
                <TableHead className="text-right">Players</TableHead>
                <TableHead className="text-right">Wagered</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">GGR</TableHead>
                <TableHead className="text-right">RTP</TableHead>
                <TableHead className="text-right">Profitable</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.risks.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={8}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No Keno games recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                data.risks.map((row) => (
                  <TableRow key={row.risk}>
                    <TableCell className="font-medium capitalize">
                      {row.risk}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.games)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.players)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(row.wager)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(row.payout)}
                    </TableCell>
                    <TableCell
                      className={
                        row.ggr >= 0
                          ? "text-right tabular-nums text-emerald-600 dark:text-emerald-400"
                          : "text-right tabular-nums text-rose-600 dark:text-rose-400"
                      }
                    >
                      {formatCurrency(row.ggr)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {percent(row.rtp)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {percent(row.profitableRate)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading icon={Dices} title="Performance by numbers picked" />
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Picks</TableHead>
                <TableHead className="text-right">Games</TableHead>
                <TableHead className="text-right">Wagered</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">GGR</TableHead>
                <TableHead className="text-right">RTP</TableHead>
                <TableHead className="text-right">Cash return</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.picks.map((row) => (
                <TableRow key={row.picks}>
                  <TableCell className="font-medium">
                    {row.picks} {row.picks === 1 ? "number" : "numbers"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.games)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.wager)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCurrency(row.payout)}
                  </TableCell>
                  <TableCell
                    className={
                      row.ggr >= 0
                        ? "text-right tabular-nums text-emerald-600 dark:text-emerald-400"
                        : "text-right tabular-nums text-rose-600 dark:text-rose-400"
                    }
                  >
                    {formatCurrency(row.ggr)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percent(row.rtp)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {percent(row.cashReturnRate)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-3">
        <SectionHeading icon={BarChart3} title="Daily activity · last 14 days" />
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>UTC day</TableHead>
                <TableHead className="text-right">Games</TableHead>
                <TableHead className="text-right">Wagered</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">GGR</TableHead>
                <TableHead className="text-right">RTP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.daily.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="h-24 text-center text-muted-foreground"
                  >
                    No activity in the last 14 days.
                  </TableCell>
                </TableRow>
              ) : (
                data.daily.map((row) => (
                  <TableRow key={row.day}>
                    <TableCell className="font-mono text-xs">
                      {row.day}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(row.games)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(row.wager)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCurrency(row.payout)}
                    </TableCell>
                    <TableCell
                      className={
                        row.ggr >= 0
                          ? "text-right tabular-nums text-emerald-600 dark:text-emerald-400"
                          : "text-right tabular-nums text-rose-600 dark:text-rose-400"
                      }
                    >
                      {formatCurrency(row.ggr)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {percent(row.rtp)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}
