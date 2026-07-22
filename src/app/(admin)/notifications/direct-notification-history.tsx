import { History, Send, Users } from "lucide-react";
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
import { formatDateTime, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { getDirectNotificationHistory } from "./_queries/direct-history";

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

  return (
    <div className="space-y-3">
      <SectionHeading icon={History} title="Send history" />
      <p className="text-xs text-muted-foreground">
        Recorded from the admin audit trail. Bulk chunks are folded into one
        row per campaign.
      </p>

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
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0">
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
                    {e.kind === "bulk" ? (
                      <Users className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Send className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm">
                        {e.kind === "bulk"
                          ? (e.campaign ?? "(no campaign)")
                          : (e.targetUserId ?? "(unknown user)")}
                      </p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {e.kind === "bulk" && e.chunks > 1 && (
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
