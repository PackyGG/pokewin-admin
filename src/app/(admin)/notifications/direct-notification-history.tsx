import { CheckCheck, History, Info, Send, Ticket, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { SectionHeading } from "@/components/modern-panels";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { readDbEnv } from "@/lib/db-env";
import { getDirectNotificationHistory } from "./_queries/direct-history";
import {
  getDirectNotificationReadStats,
  type DirectNotificationReadStat,
} from "./_queries/direct-read-analytics";

/**
 * Everything sent from this page, newest first — reconstructed from the admin
 * audit trail (see `_queries/direct-history`), because no backend endpoint
 * lists admin-sent notifications.
 *
 * Server component behind its own Suspense boundary so it never blocks the
 * composer's first paint.
 */
export async function DirectNotificationHistory() {
  const { data: entries, error } = await safeQuery(
    () => getDirectNotificationHistory(),
    [],
    "notifications.directHistory",
    10_000,
  );
  const activeEnv = await readDbEnv();
  const { data: readStats, error: readStatsError } = await safeQuery(
    () => getDirectNotificationReadStats(entries, activeEnv),
    {},
    "notifications.directReadStats",
    15_000,
  );

  return (
    <div className="space-y-3">
      <SectionHeading icon={History} title="Send history" />
      <p className="text-xs text-muted-foreground">
        Recorded from the admin audit trail. Bulk chunks are folded into one
        row per campaign.
      </p>
      <div className="flex items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <p>
          Read analytics are exact for sends that retained recipient tracking
          keys. Older bulk sends may show unavailable. “Read” is not an
          impression, time viewed, or link click.
        </p>
      </div>

      <div className="rounded-md border overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Requested</TableHead>
              <TableHead className="text-right">Created</TableHead>
              <TableHead className="text-right">Deduped</TableHead>
              <TableHead className="text-right">Unknown</TableHead>
              <TableHead className="text-right">Marked read</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={9} className="p-0">
                  <EmptyState
                    icon={History}
                    title={
                      error ? "Couldn't load history" : "Nothing sent yet"
                    }
                    description={
                      error
                        ? "The audit read failed or timed out — refresh to retry."
                        : "Sends from this page show up here, with their created / deduped counts."
                    }
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {formatDateTime(e.sentAt)}
                </TableCell>

                <TableCell className="max-w-[280px]">
                  <div className="flex items-start gap-2">
                    {e.kind === "reward" ? (
                      <Ticket className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    ) : e.kind === "bulk" ? (
                      <Users className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Send className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        {e.kind === "single"
                          ? (e.targetUserId ?? "(unknown user)")
                          : (e.campaign ?? "(no campaign)")}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {e.kind === "reward" && (
                          <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                            {formatCurrency(e.valueUsd ?? 0)} ×{" "}
                            {formatNumber(e.codesMinted)} minted
                          </span>
                        )}
                        {e.kind !== "single" && e.chunks > 1 && (
                          <span className="text-[10px] text-muted-foreground">
                            {e.chunks} chunks
                          </span>
                        )}
                        {e.env && (
                          <Badge
                            variant="outline"
                            className={
                              e.env === "dev"
                                ? "px-1.5 py-0 text-[10px] uppercase bg-blue-500/15 text-blue-600 dark:text-blue-400"
                                : "px-1.5 py-0 text-[10px] uppercase"
                            }
                          >
                            {e.env}
                          </Badge>
                        )}
                      </div>
                      {e.samplePayload && (
                        <p className="truncate font-mono text-[10px] text-muted-foreground">
                          {JSON.stringify(e.samplePayload)}
                        </p>
                      )}
                    </div>
                  </div>
                </TableCell>

                <TableCell>
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="font-mono text-[11px]">
                      {e.type ?? "—"}
                    </span>
                    {e.category && (
                      <span className="text-[10px] text-muted-foreground">
                        {e.category}
                      </span>
                    )}
                  </div>
                </TableCell>

                <TableCell className="text-right text-xs tabular-nums">
                  {formatNumber(e.requested)}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {e.kind === "single" ? (
                    <span
                      className="text-muted-foreground"
                      title="The single-user endpoint can't report created vs deduped"
                    >
                      n/a
                    </span>
                  ) : (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {formatNumber(e.created)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {e.kind === "single" ? (
                    <span className="text-muted-foreground">n/a</span>
                  ) : (
                    <span className="text-blue-600 dark:text-blue-400">
                      {formatNumber(e.deduped)}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {e.unknownUsers.length > 0 ? (
                    <span
                      className="text-amber-600 dark:text-amber-400"
                      title={e.unknownUsers.join("\n")}
                    >
                      {formatNumber(e.unknownUsers.length)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <ReadStatCell
                    stat={readStats[e.id]}
                    unavailable={readStatsError !== null}
                  />
                </TableCell>

                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  {e.adminUsername ?? "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function ReadStatCell({
  stat,
  unavailable,
}: {
  stat: DirectNotificationReadStat | undefined;
  unavailable: boolean;
}) {
  if (unavailable) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="Read analytics could not be loaded. Refresh to retry."
      >
        Unavailable
      </span>
    );
  }

  if (!stat || stat.status !== "exact") {
    const labels = {
      "not-tracked": "Not tracked",
      "different-environment": "Other env",
      deferred: "Load limit",
    } as const;
    const descriptions = {
      "not-tracked":
        "This send predates exact recipient tracking, or was a single send without a dedupe key.",
      "different-environment":
        "Switch the dashboard database environment to the environment shown on this send.",
      deferred:
        "The newest complete campaigns already reached the 25,000-recipient analytics limit for this render.",
    } as const;
    const status = stat?.status ?? "not-tracked";
    return (
      <span
        className="text-xs text-muted-foreground"
        title={descriptions[status]}
      >
        {labels[status]}
      </span>
    );
  }

  const rate =
    stat.delivered > 0 ? Math.round((stat.read / stat.delivered) * 100) : 0;
  return (
    <div
      className="inline-flex flex-col items-end"
      title={`${formatNumber(stat.read)} of ${formatNumber(stat.delivered)} tracked notifications marked read`}
    >
      <span className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums">
        <CheckCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        {formatNumber(stat.read)} / {formatNumber(stat.delivered)}
      </span>
      <span className="text-[10px] text-muted-foreground">{rate}%</span>
    </div>
  );
}
