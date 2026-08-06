"use client";

import * as React from "react";
import {
  AlertTriangle,
  Check,
  Eye,
  Loader2,
  RefreshCw,
  Target,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getKenoMultiplier,
  KENO_GRID_SIZE,
  KENO_MAX_CONFIGURABLE_BET_USD,
  KENO_MAX_PICKS,
  KENO_MIN_BET_USD,
  KENO_RISK_MODES,
} from "@/lib/keno/payouts";
import { cn } from "@/lib/utils";
import { revealKenoNextPreviewAction } from "./actions";
import type { KenoNextPreview } from "./types";

const DEFAULT_SELECTED_NUMBERS = Array.from(
  { length: KENO_MAX_PICKS },
  (_, index) => index + 1,
);

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function KenoNextPreviewClient({
  targetUserId,
}: {
  targetUserId: string;
}) {
  const [preview, setPreview] = React.useState<KenoNextPreview | null>(null);
  const [selectedNumbers, setSelectedNumbers] = React.useState<number[]>(
    DEFAULT_SELECTED_NUMBERS,
  );
  const [betInput, setBetInput] = React.useState("1.00");
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const bet = Number(betInput);
  const betIsValid =
    Number.isFinite(bet) &&
    bet >= KENO_MIN_BET_USD &&
    bet <= KENO_MAX_CONFIGURABLE_BET_USD;
  const drawnSet = React.useMemo(
    () => new Set(preview?.drawnNumbers ?? []),
    [preview],
  );
  const hits = selectedNumbers.filter((number) => drawnSet.has(number)).length;

  function revealPreview() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await revealKenoNextPreviewAction();
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setPreview(result.preview);
      } catch {
        setError("Could not load the next Keno preview. Please retry.");
      }
    });
  }

  function toggleNumber(number: number) {
    setSelectedNumbers((current) => {
      if (current.includes(number)) {
        return current.filter((value) => value !== number);
      }
      if (current.length >= KENO_MAX_PICKS) return current;
      return [...current, number].sort((left, right) => left - right);
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <p className="text-xs text-amber-700 dark:text-amber-300">
          This snapshot is valid only if this user&apos;s next seed-consuming
          action is Keno. Any other game, concurrent bet, or seed rotation
          changes the next nonce.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="size-4 text-primary" /> Fixed test account
          </CardTitle>
          <CardDescription className="break-all">
            {targetUserId}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button onClick={revealPreview} disabled={isPending}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : preview ? (
              <RefreshCw className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
            {preview ? "Refresh snapshot" : "Reveal next draw"}
          </Button>
          {preview ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">Nonce {preview.nonce}</Badge>
              <span>{preview.username ?? "Unknown username"}</span>
              <span>Snapshot {preview.snapshotId}</span>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      {preview ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Predicted next draw</CardTitle>
              <CardDescription>
                Drawn numbers for nonce {preview.nonce}. The committed
                server-seed hash was verified before calculating this result.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {preview.drawnNumbers.map((number) => (
                  <span
                    key={number}
                    className="flex size-9 items-center justify-center rounded-full bg-primary font-mono text-sm font-semibold text-primary-foreground"
                  >
                    {number}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                <span className="break-all">
                  Seed hash: {preview.serverSeedHash}
                </span>
                <span>
                  Revealed {new Date(preview.revealedAt).toLocaleString()}
                </span>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Test tiles</CardTitle>
                <CardDescription>
                  Choose 1–10 tiles. The default is a 10-tile bet.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-5 gap-2 sm:grid-cols-8">
                  {Array.from({ length: KENO_GRID_SIZE }, (_, index) => {
                    const number = index + 1;
                    const selected = selectedNumbers.includes(number);
                    const drawn = drawnSet.has(number);
                    return (
                      <Button
                        key={number}
                        type="button"
                        variant={selected ? "default" : "outline"}
                        size="sm"
                        aria-pressed={selected}
                        onClick={() => toggleNumber(number)}
                        className={cn(
                          "relative font-mono",
                          drawn &&
                            !selected &&
                            "border-emerald-500/60 text-emerald-600",
                          drawn &&
                            selected &&
                            "ring-2 ring-emerald-400 ring-offset-2 ring-offset-background",
                        )}
                      >
                        {number}
                        {drawn && selected ? (
                          <Check className="absolute -right-1 -top-1 size-3 rounded-full bg-emerald-500 text-white" />
                        ) : null}
                      </Button>
                    );
                  })}
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="space-y-1 text-xs font-medium">
                    Bet amount (USD)
                    <Input
                      type="number"
                      min={KENO_MIN_BET_USD}
                      max={KENO_MAX_CONFIGURABLE_BET_USD}
                      step="0.01"
                      value={betInput}
                      onChange={(event) => setBetInput(event.target.value)}
                      className="w-36"
                    />
                  </label>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setSelectedNumbers(preview.drawnNumbers)}
                  >
                    Select predicted 10
                  </Button>
                  <Badge variant="outline">
                    {selectedNumbers.length} picks · {hits} hits
                  </Badge>
                </div>
                {!betIsValid ? (
                  <p className="text-xs text-destructive">
                    Enter a bet from {formatUsd(KENO_MIN_BET_USD)} to{" "}
                    {formatUsd(KENO_MAX_CONFIGURABLE_BET_USD)}.
                  </p>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Pre-run result</CardTitle>
                <CardDescription>
                  The same draw evaluated against every Keno risk mode.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Risk</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead className="text-right">Multiplier</TableHead>
                      <TableHead className="text-right">Payout</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {KENO_RISK_MODES.map((risk) => {
                      const multiplier = getKenoMultiplier(
                        risk,
                        selectedNumbers.length,
                        hits,
                      );
                      const payout =
                        betIsValid && multiplier > 0
                          ? Number((bet * multiplier).toFixed(2))
                          : 0;
                      return (
                        <TableRow
                          key={risk}
                          className={
                            risk === "high" ? "bg-amber-500/5" : undefined
                          }
                        >
                          <TableCell className="capitalize font-medium">
                            {risk}
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={multiplier > 0 ? "default" : "secondary"}
                            >
                              {multiplier > 0 ? "Win" : "Lose"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {multiplier}×
                          </TableCell>
                          <TableCell className="text-right font-mono font-semibold">
                            {betIsValid ? formatUsd(payout) : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
        </>
      ) : null}
    </div>
  );
}
