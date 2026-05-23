"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import { FileText } from "lucide-react";

const TYPE_LABELS: Record<string, string> = {
  flat_fee: "Flat Fee",
  rev_share: "Rev Share",
  hybrid: "Hybrid",
  custom: "Custom",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  active: "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30",
  completed: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  cancelled: "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30",
};

type Deal = {
  id: string;
  dealName: string | null;
  dealType: string;
  amount: number;
  currency: string;
  startDate: string;
  endDate: string | null;
  status: string;
  notes: string | null;
  keepPercentage: number | null;
  currencyLimitAmount: number | null;
  currencyLimitResetDays: number | null;
  percentageLimit: number | null;
  tipLimit: number | null;
  tipLimitResetDays: number | null;
  leaderboardPrizePool: number | null;
  leaderboardOurShare: number | null;
  leaderboardFrequency: string | null;
  minStreamMinutes: number | null;
  maxFinancialExposure: number | null;
};

function InfoBlock({ label, value, sub, subColor }: { label: string; value: string; sub?: string; subColor?: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
      {sub && <p className={`text-xs ${subColor ?? "text-muted-foreground"}`}>{sub}</p>}
    </div>
  );
}

export function DealsTable({ deals }: { deals: Deal[] }) {
  const [selected, setSelected] = useState<Deal | null>(null);

  return (
    <>
      <Card>
        <CardContent>
          <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deals.map((d) => (
                <TableRow
                  key={d.id}
                  className="cursor-pointer"
                  onClick={() => setSelected(d)}
                >
                  <TableCell>
                    <Badge variant="outline">
                      {TYPE_LABELS[d.dealType] ?? d.dealType}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatCurrency(d.amount)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {d.startDate.split("T")[0]}
                    {d.endDate ? ` — ${d.endDate.split("T")[0]}` : " — ongoing"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={STATUS_COLORS[d.status] ?? ""}>
                      {d.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[200px] truncate text-sm text-muted-foreground">
                    {d.notes ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
              {deals.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="p-0">
                    <EmptyState
                      icon={FileText}
                      title="No deals yet"
                      description="Creator deals set up for your account appear here."
                      compact
                    />
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected?.dealName || TYPE_LABELS[selected?.dealType ?? ""] || selected?.dealType}
              {selected && (
                <>
                  <Badge variant="outline">{TYPE_LABELS[selected.dealType] ?? selected.dealType}</Badge>
                  <Badge variant="outline" className={STATUS_COLORS[selected.status] ?? ""}>{selected.status}</Badge>
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <InfoBlock label="Base Amount" value={formatCurrency(selected.amount)} />
                <InfoBlock
                  label="Duration"
                  value={`${selected.startDate.split("T")[0]} — ${selected.endDate ? selected.endDate.split("T")[0] : "ongoing"}`}
                />

                {selected.keepPercentage != null && selected.keepPercentage > 0 && (
                  <InfoBlock label="Keep %" value={`${(selected.keepPercentage * 100).toFixed(0)}%`} />
                )}

                {(selected.currencyLimitAmount != null || selected.percentageLimit != null || selected.tipLimit != null) && (
                  <InfoBlock
                    label="Withdrawal Limits"
                    value={[
                      selected.currencyLimitAmount != null ? `${formatCurrency(selected.currencyLimitAmount)}${selected.currencyLimitResetDays ? ` / ${selected.currencyLimitResetDays}d` : ""}` : null,
                      selected.percentageLimit != null ? `${(selected.percentageLimit * 100).toFixed(2)}%` : null,
                      selected.tipLimit != null ? `Tip: ${formatCurrency(selected.tipLimit)}${selected.tipLimitResetDays ? ` / ${selected.tipLimitResetDays}d` : ""}` : null,
                    ].filter(Boolean).join(" · ")}
                  />
                )}

                {selected.leaderboardPrizePool != null && selected.leaderboardPrizePool > 0 && (
                  <InfoBlock
                    label="Leaderboard"
                    value={`${formatCurrency(selected.leaderboardPrizePool)} pool`}
                    sub={`${((selected.leaderboardOurShare ?? 0) * 100).toFixed(0)}% us · ${selected.leaderboardFrequency ?? "—"}`}
                  />
                )}

                {selected.minStreamMinutes != null && (
                  <InfoBlock label="Min Stream" value={`${selected.minStreamMinutes} min`} />
                )}
              </div>


              {selected.notes && (
                <p className="text-sm text-muted-foreground">{selected.notes}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
