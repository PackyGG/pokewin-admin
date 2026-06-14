import Link from "next/link";
import { Percent, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";

type RakebackClaim = {
  id: string;
  userId: string;
  username: string | null;
  rakebackType: string;
  periodStart: string;
  wageredAmountUsd: number;
  rakebackAmountUsd: number;
  claimedAt: string | null;
  /** True = early/instant-claimed (rakeback_claims.last_preclaim_at set). */
  instant: boolean;
  /** Accrued rakeback before the instant-claim fee (instant rows only). */
  instantAccruedAmountUsd: number | null;
};

function RakebackAmountCell({
  paidUsd,
  instantAccruedUsd,
}: {
  paidUsd: number;
  instantAccruedUsd: number | null;
}) {
  const showBeforeFee =
    instantAccruedUsd != null &&
    Number.isFinite(instantAccruedUsd) &&
    instantAccruedUsd > paidUsd + 0.001;

  if (!showBeforeFee) {
    return (
      <span className="font-medium tabular-nums text-rose-600 dark:text-rose-400">
        {formatCurrency(paidUsd)}
      </span>
    );
  }

  return (
    <div
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 tabular-nums"
      title="Accrued rakeback before the instant-claim fee → amount paid out"
    >
      <span className="font-medium text-muted-foreground">
        {formatCurrency(instantAccruedUsd)}
      </span>
      <span className="text-muted-foreground/70">→</span>
      <span className="font-medium text-rose-600 dark:text-rose-400">
        {formatCurrency(paidUsd)}
      </span>
    </div>
  );
}

/** "Instant" pill for early-claimed rakeback rows. */
function InstantBadge() {
  return (
    <Badge
      variant="outline"
      className="h-4 gap-0.5 px-1 text-[9px] bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30"
      title="Early-claimed (instant) rakeback"
    >
      <Zap className="size-2.5" />
      Instant
    </Badge>
  );
}

function ClaimMobileCard({ c }: { c: RakebackClaim }) {
  const claimed = c.claimedAt != null;
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-rose-500/10 shrink-0">
          <Percent className="size-4 text-rose-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Link
              href={`/users/${c.userId}`}
              className="text-sm font-medium hover:underline truncate"
            >
              {c.username ?? c.userId.slice(0, 8)}
            </Link>
            <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">
              {c.rakebackType}
            </Badge>
            {c.instant && <InstantBadge />}
            {claimed ? (
              <Badge
                variant="outline"
                className="h-4 px-1 text-[9px] bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
              >
                Claimed
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="h-4 px-1 text-[9px] bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
              >
                Pending
              </Badge>
            )}
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            <span className="tabular-nums">
              {formatCurrency(c.wageredAmountUsd)} wagered
            </span>
            <span> · {formatRelative(c.periodStart)}</span>
            {claimed && c.claimedAt && (
              <span> · {formatRelative(c.claimedAt)}</span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <RakebackAmountCell
            paidUsd={c.rakebackAmountUsd}
            instantAccruedUsd={c.instant ? c.instantAccruedAmountUsd : null}
          />
        </div>
      </div>
    </div>
  );
}

export function RakebackClaimsTable({ data }: { data: RakebackClaim[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Percent}
              title="No claims found"
              description="Rakeback claims appear here once players claim a rebate on their wagering."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((c) => (
              <ClaimMobileCard key={c.id} c={c} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Period</TableHead>
              <TableHead>Wagered</TableHead>
              <TableHead>Rakeback</TableHead>
              <TableHead>Claimed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell>
                  <Link
                    href={`/users/${c.userId}`}
                    className="hover:underline"
                  >
                    {c.username ?? c.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="capitalize">
                      {c.rakebackType}
                    </Badge>
                    {c.instant && <InstantBadge />}
                  </div>
                </TableCell>
                <TableCell>{formatDateTime(c.periodStart)}</TableCell>
                <TableCell>{formatCurrency(c.wageredAmountUsd)}</TableCell>
                <TableCell>
                  <RakebackAmountCell
                    paidUsd={c.rakebackAmountUsd}
                    instantAccruedUsd={c.instant ? c.instantAccruedAmountUsd : null}
                  />
                </TableCell>
                <TableCell>
                  {c.claimedAt ? (
                    <Badge
                      variant="outline"
                      className="bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                    >
                      {formatDateTime(c.claimedAt)}
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                    >
                      Pending
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="p-0">
                  <EmptyState
                    icon={Percent}
                    title="No claims found"
                    description="Rakeback claims appear here once players claim a rebate on their wagering."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
