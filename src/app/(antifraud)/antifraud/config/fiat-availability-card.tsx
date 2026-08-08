"use client";

import { useEffect, useState, useTransition } from "react";
import { AlertTriangle, CreditCard, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { setGlobalFiatDeposits } from "@/app/(admin)/system/geo-blocking/actions";

export function GlobalFiatAvailabilityCard({
  initialAllowed,
}: {
  initialAllowed: boolean | null;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [allowed, setAllowed] = useState(initialAllowed ?? false);
  const [requestedAllowed, setRequestedAllowed] = useState<boolean | null>(null);
  const [cacheStale, setCacheStale] = useState(false);

  useEffect(() => {
    if (initialAllowed !== null) setAllowed(initialAllowed);
  }, [initialAllowed]);

  if (initialAllowed === null) {
    return (
      <Card className="border-dashed">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Global Fiat deposits</CardTitle>
          <CardDescription>Allows or blocks Fiat deposit methods site-wide.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">Global setting unavailable</p>
              <p className="text-amber-600/80 dark:text-amber-400/80">
                The authoritative Fiat lock state could not be loaded, so the switch is disabled.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => router.refresh()}
              >
                Retry
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  function submit() {
    if (requestedAllowed === null) return;
    const nextAllowed = requestedAllowed;
    startTransition(async () => {
      try {
        const result = await setGlobalFiatDeposits(nextAllowed);
        setAllowed(nextAllowed);
        setRequestedAllowed(null);
        if (result.siteConfigCacheReloaded) {
          setCacheStale(false);
          toast.success(nextAllowed ? "Fiat deposits enabled globally" : "Fiat deposits disabled globally");
        } else {
          setCacheStale(true);
          toast.warning(
            "The global Fiat gate was saved, but the backend cache did not reload. Reload the site-config cache before treating the change as live.",
            { duration: 12000 },
          );
        }
        router.refresh();
      } catch (error) {
        console.error("[fiat-availability] update failed", error);
        toast.error("Global Fiat update failed. Refresh and try again.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="max-w-3xl space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <CreditCard className="size-4 text-muted-foreground" />
              Global Fiat deposits
            </CardTitle>
            <Badge
              variant="outline"
              className={
                allowed
                  ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
              }
            >
              {cacheStale ? "Saved · cache stale" : allowed ? "Allowed" : "Disabled"}
            </Badge>
            <Switch
              aria-label="Global Fiat deposits"
              checked={allowed}
              disabled={isPending}
              onCheckedChange={setRequestedAllowed}
            />
          </div>
          <CardDescription>
            When disabled, card and wallet Fiat deposit methods are blocked site-wide.
            Mandatory jurisdiction restrictions still apply when enabled.
          </CardDescription>
          {cacheStale && (
            <div role="status" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              The database setting was saved, but the backend cache did not reload.
              The displayed value is not confirmed active yet. Use Geo Blocking → Reload cache, then refresh this page.
            </div>
          )}
        </div>
      </CardHeader>
      <AlertDialog
        open={requestedAllowed !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setRequestedAllowed(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {requestedAllowed ? "Enable Fiat deposits globally?" : "Disable Fiat deposits globally?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {requestedAllowed
                ? "Fiat deposit methods will become available for eligible accounts outside mandatory restricted jurisdictions."
                : "Card and wallet Fiat deposit methods will be blocked for every user until this switch is enabled again."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <Button onClick={submit} disabled={isPending} variant={requestedAllowed ? "default" : "destructive"}>
              {isPending && <Loader2 className="size-4 animate-spin" />}
              {isPending ? "Saving..." : "Confirm change"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
