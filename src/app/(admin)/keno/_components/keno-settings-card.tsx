"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Info } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ux";
import { updateKenoConfigAction } from "../actions";
import type { KenoConfig } from "@/lib/backend-api/keno-config";
import {
  KENO_DEFAULT_MAX_BET_USD,
  KENO_DEFAULT_MAX_WIN_USD,
  KENO_MAX_CONFIGURABLE_BET_USD,
  KENO_MIN_BET_USD,
} from "@/lib/keno/payouts";

/**
 * Keno bet and payout limit editor.
 *
 * Keno's maximum bet and maximum win share the dedicated backend admin
 * endpoint in Analytics → Games → Keno. The three destination wager weights
 * live only on /security.
 *
 * The minimum bet, grid, draw count, pick range, risk modes and payout tables
 * remain compile-time backend constants.
 */

export function KenoSettingsCard({
  kenoConfig,
  canEdit,
}: {
  kenoConfig: KenoConfig | null;
  canEdit: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [maxBetBaseline, setMaxBetBaseline] = useState<number | undefined>(
    () => kenoConfig?.max_bet_usd,
  );
  const [maxBetValue, setMaxBetValue] = useState(
    () => kenoConfig?.max_bet_usd.toString() ?? "",
  );
  const [maxWinBaseline, setMaxWinBaseline] = useState<number | undefined>(
    () => kenoConfig?.max_win_usd,
  );
  const [maxWinValue, setMaxWinValue] = useState(
    () => kenoConfig?.max_win_usd.toString() ?? "",
  );

  if (!kenoConfig) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Keno system configuration
          </CardTitle>
          <CardDescription>
            Live maximum bet and maximum payout limits.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-medium">Backend not reachable</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The Keno configuration endpoint did not respond, so the
                current limits are unknown. This card becomes editable once
                the backend is reachable again.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const handleSave = () => {
    let changedMaxBet: number | undefined;
    let parsedMaxBet = maxBetBaseline;
    if (maxBetBaseline !== undefined) {
      const raw = maxBetValue.trim();
      if (raw === "") {
        toast.error("Maximum bet is required");
        return;
      }
      const parsed = Number(raw);
      if (
        !Number.isFinite(parsed) ||
        parsed < KENO_MIN_BET_USD ||
        parsed > KENO_MAX_CONFIGURABLE_BET_USD
      ) {
        toast.error(
          `Maximum bet must be between $${KENO_MIN_BET_USD.toFixed(2)} and $${KENO_MAX_CONFIGURABLE_BET_USD.toLocaleString("en-US")}`,
        );
        return;
      }
      if (parsed !== maxBetBaseline) {
        changedMaxBet = parsed;
      }
      parsedMaxBet = parsed;
    }

    let changedMaxWin: number | undefined;
    let parsedMaxWin = maxWinBaseline;
    if (maxWinBaseline !== undefined) {
      const raw = maxWinValue.trim();
      if (raw === "") {
        toast.error("Maximum win is required");
        return;
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error("Maximum win must be greater than $0");
        return;
      }
      if (parsed !== maxWinBaseline) {
        changedMaxWin = parsed;
      }
      parsedMaxWin = parsed;
    }

    if (changedMaxBet === undefined && changedMaxWin === undefined) {
      toast.info("No changes to save");
      return;
    }

    startTransition(async () => {
      if (parsedMaxBet === undefined || parsedMaxWin === undefined) return;
      const result = await updateKenoConfigAction({
        max_bet_usd: parsedMaxBet,
        max_win_usd: parsedMaxWin,
      });
      if (result.success) {
        setMaxBetBaseline(result.data.max_bet_usd);
        setMaxBetValue(result.data.max_bet_usd.toString());
        setMaxWinBaseline(result.data.max_win_usd);
        setMaxWinValue(result.data.max_win_usd.toString());
        toast.success("Keno configuration updated");
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">
            Keno system configuration
          </CardTitle>
          <Badge variant="secondary">2 live settings</Badge>
        </div>
        <CardDescription>
          Maximum bet and maximum win. Wager weights are managed under System
          → Security. All saves go through the backend admin API and the admin
          audit trail.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
          <Info className="size-4 shrink-0 mt-0.5" />
          <p className="text-blue-600/80 dark:text-blue-400/80">
            The maximum bet applies immediately to new games. Existing games
            and settled results are unchanged. The maximum win caps the final
            payout after its multiplier is applied.
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Maximum bet</p>
              <code className="block truncate text-[10px] text-muted-foreground">
                keno_max_bet_usd
              </code>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="keno-max-bet">USD per game</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                Default ${KENO_DEFAULT_MAX_BET_USD.toFixed(2)}
              </span>
            </div>
            <Input
              id="keno-max-bet"
              type="number"
              step="0.01"
              min={KENO_MIN_BET_USD}
              max={KENO_MAX_CONFIGURABLE_BET_USD}
              value={maxBetValue}
              onChange={(event) => setMaxBetValue(event.target.value)}
              disabled={
                isPending || maxBetBaseline === undefined || !canEdit
              }
            />
            <p className="text-[11px] text-muted-foreground">
              {maxBetBaseline === undefined ? (
                <span className="text-amber-600 dark:text-amber-400">
                  Current value unavailable — the Keno config endpoint
                  didn&apos;t respond.
                </span>
              ) : (
                <>
                  Allowed range ${KENO_MIN_BET_USD.toFixed(2)}–$
                  {KENO_MAX_CONFIGURABLE_BET_USD.toLocaleString("en-US")}.
                  Applies immediately to future games.
                </>
              )}
            </p>
          </div>

          <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Maximum win</p>
              <code className="block truncate text-[10px] text-muted-foreground">
                keno_max_win_usd
              </code>
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="keno-max-win">USD per game</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                Default ${KENO_DEFAULT_MAX_WIN_USD.toLocaleString("en-US")}
              </span>
            </div>
            <Input
              id="keno-max-win"
              type="number"
              step="0.01"
              min="0.01"
              value={maxWinValue}
              onChange={(event) => setMaxWinValue(event.target.value)}
              disabled={
                isPending || maxWinBaseline === undefined || !canEdit
              }
            />
            <p className="text-[11px] text-muted-foreground">
              {maxWinBaseline === undefined ? (
                <span className="text-amber-600 dark:text-amber-400">
                  Current value unavailable — the Keno config endpoint
                  didn&apos;t return a win cap.
                </span>
              ) : (
                <>
                  Caps the final payout after the selected multiplier. Applies
                  immediately to future games.
                </>
              )}
            </p>
          </div>

        </div>

        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={isPending || !canEdit}>
            {isPending && <Spinner size={15} className="text-current" />}
            {isPending
              ? "Saving..."
              : canEdit
                ? "Save changes"
                : "Admin access required"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
