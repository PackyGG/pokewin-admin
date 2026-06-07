"use client";

import { useEffect, useState } from "react";
import { Loader2, Swords } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import {
  getUserJoinedSponsoredBattles,
  type JoinedBattleRow,
} from "./actions";

const RESULT_STYLES: Record<JoinedBattleRow["result"], string> = {
  win: "border-emerald-500/30 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  lose: "border-rose-500/30 bg-rose-500/15 text-rose-700 dark:text-rose-300",
  pending:
    "border-amber-500/30 bg-amber-500/15 text-amber-700 dark:text-amber-300",
};

/**
 * Battles the user JOINED with no `battle_bet` ledger row (fully sponsored /
 * free entry). These never appear in the normal gaming history because that
 * reads only `ledger_transactions` — surfacing them here explains the
 * inventory/balance changes from those wins. Self-fetching; hidden when none.
 */
export function JoinedBattlesPanel({ userId }: { userId: string }) {
  const [battles, setBattles] = useState<JoinedBattleRow[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getUserJoinedSponsoredBattles(userId)
      .then((rows) => {
        if (!cancelled) setBattles(rows);
      })
      .catch(() => {
        if (!cancelled) setBattles([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!loading && (!battles || battles.length === 0)) return null;

  const totalWinnings = (battles ?? []).reduce((a, b) => a + b.winnings, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Swords className="size-4" />
          Sponsored / free battles joined
          {battles && battles.length > 0 && (
            <span className="text-muted-foreground">
              — {battles.length} ·{" "}
              <span className="tabular-nums">
                {formatCurrency(totalWinnings)} won
              </span>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="mb-2 text-[11px] text-muted-foreground">
              Battles this user joined with a $0 / sponsored entry — these
              don&apos;t create a ledger row, so they&apos;re not in the normal
              gaming history. Winnings shown are the cards they took.
            </p>
            {(battles ?? []).map((b) => (
              <div
                key={b.gameSessionId}
                className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge
                    variant="outline"
                    className={`text-[10px] capitalize ${RESULT_STYLES[b.result]}`}
                  >
                    {b.result === "pending" ? "in progress" : b.result}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatRelative(b.at)}
                  </span>
                  {b.sponsorshipPercentage > 0 && (
                    <span className="text-[10px] text-muted-foreground">
                      · {b.sponsorshipPercentage}% sponsored
                    </span>
                  )}
                </div>
                <span className="shrink-0 font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {b.winnings > 0 ? formatCurrency(b.winnings) : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
