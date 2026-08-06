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
import { KENO_GRID_SIZE } from "@/lib/keno/payouts";
import { revealKenoNextPreviewAction } from "./actions";
import type { KenoNextPreview } from "./types";

export function KenoNextPreviewClient({
  targetUserId,
}: {
  targetUserId: string;
}) {
  const [preview, setPreview] = React.useState<KenoNextPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isPending, startTransition] = React.useTransition();

  const drawnSet = React.useMemo(
    () => new Set(preview?.drawnNumbers ?? []),
    [preview],
  );

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
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Predicted next tiles</CardTitle>
              <Badge>10 tiles hit</Badge>
            </div>
            <CardDescription>
              The highlighted player-facing tiles are the fixed draw for nonce{" "}
              {preview.nonce}. Risk mode does not change them.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ol className="grid grid-cols-5 gap-2 sm:grid-cols-8">
              {Array.from({ length: KENO_GRID_SIZE }, (_, index) => {
                const number = index + 1;
                const drawn = drawnSet.has(number);
                return (
                  <li
                    key={number}
                    aria-label={`Tile ${number}${drawn ? ", predicted hit" : ""}`}
                    className={
                      drawn
                        ? "relative flex h-12 items-center justify-center rounded-lg bg-primary font-mono text-sm font-semibold text-primary-foreground ring-2 ring-primary/30"
                        : "flex h-12 items-center justify-center rounded-lg border border-border bg-muted/30 font-mono text-sm text-muted-foreground"
                    }
                  >
                    {number}
                    {drawn ? (
                      <Check className="absolute right-1.5 top-1.5 size-3" />
                    ) : null}
                  </li>
                );
              })}
            </ol>
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
      ) : null}
    </div>
  );
}
