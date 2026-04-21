import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils/format";

type Props = {
  wagerVolumeUsd: number;
  earnedUsd: number;
  availableUsd: number;
  paidOutUsd: number;
  bonusDistributedUsd: number;
};

export function FinancialsCard({
  wagerVolumeUsd,
  earnedUsd,
  availableUsd,
  paidOutUsd,
  bonusDistributedUsd,
}: Props) {
  const rows = [
    { label: "Wager Volume", value: wagerVolumeUsd },
    { label: "Total Earned", value: earnedUsd },
    { label: "Available", value: availableUsd, emphasis: true as const },
    { label: "Paid Out", value: paidOutUsd },
    { label: "Bonus Distributed", value: bonusDistributedUsd },
  ];

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-card-title">Financials</CardTitle>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Cumulative, all-time
        </p>
      </CardHeader>
      <CardContent className="flex-1 pt-0">
        <dl className="divide-y divide-border/60">
          {rows.map((r) => (
            <div
              key={r.label}
              className="flex items-center justify-between py-2 first:pt-0 last:pb-0"
            >
              <dt className="text-xs text-muted-foreground">{r.label}</dt>
              <dd
                className={
                  r.emphasis
                    ? "text-sm font-semibold tabular-nums"
                    : "text-sm tabular-nums"
                }
              >
                {formatCurrency(r.value)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
