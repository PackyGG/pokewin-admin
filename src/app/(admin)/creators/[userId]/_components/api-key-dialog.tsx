"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
} from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

import {
  getCreatorApiKeyStatus,
  rotateCreatorApiKey,
} from "../../backend-actions";

type Props = {
  userId: string;
};

type Status =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; hasApiKey: boolean }
  | { state: "error"; message: string };

export function ApiKeyDialog({ userId }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [plainKey, setPlainKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Load status when dialog opens. We refetch every time so a re-open after
  // rotation reflects reality (and so the plain-text key isn't reused from
  // stale state — rotating issues a fresh value each time).
  useEffect(() => {
    if (!open) {
      setPlainKey(null);
      setCopied(false);
      setStatus({ state: "idle" });
      return;
    }

    let cancelled = false;
    setStatus({ state: "loading" });
    (async () => {
      try {
        const result = await getCreatorApiKeyStatus(userId);
        if (cancelled) return;
        setStatus({ state: "loaded", hasApiKey: result.has_api_key });
      } catch (err) {
        if (cancelled) return;
        setStatus({
          state: "error",
          message: err instanceof Error ? err.message : "Failed to load",
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  function performRotate() {
    startTransition(async () => {
      try {
        const result = await rotateCreatorApiKey(userId);
        setPlainKey(result.api_key);
        setStatus({ state: "loaded", hasApiKey: true });
        setCopied(false);
        toast.success("API key generated");
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to rotate API key",
        );
      }
    });
  }

  async function handleCopy() {
    if (!plainKey) return;
    try {
      await navigator.clipboard.writeText(plainKey);
      setCopied(true);
      toast.success("Copied to clipboard");
      // Auto-revert the visual state after a moment so the icon hint stays
      // discoverable for repeated copies.
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy — select the value manually");
    }
  }

  const hasKey =
    status.state === "loaded" ? status.hasApiKey : false;
  const showingFreshKey = plainKey !== null;
  // Pre-rotation confirm only matters when one already exists — first-time
  // generation is harmless, but rotation invalidates any client still using
  // the old key. Skip the confirm dialog if no key exists yet.
  const rotateButtonLabel = hasKey ? "Regenerate" : "Generate API key";
  const rotateButtonIcon = hasKey ? RefreshCw : KeyRound;

  function onRotateClick() {
    if (hasKey) {
      setConfirmRotate(true);
    } else {
      performRotate();
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger
          render={<Button size="sm" variant="outline" />}
        >
          <KeyRound className="mr-1.5 size-3.5" />
          API Key
        </DialogTrigger>

        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>External API Key</DialogTitle>
            <DialogDescription>
              Used by the creator to call the external affiliate stats and
              leaderboard endpoints. The plain key is only shown once at
              generation — only its SHA-256 hash is stored.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {status.state === "loading" && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading status…
              </div>
            )}

            {status.state === "error" && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                {status.message}
              </div>
            )}

            {status.state === "loaded" && !showingFreshKey && (
              <div
                className={`rounded-md border p-3 text-sm ${
                  hasKey
                    ? "border-emerald-500/30 bg-emerald-500/5"
                    : "border-amber-500/30 bg-amber-500/5"
                }`}
              >
                {hasKey ? (
                  <span className="text-emerald-500">
                    An API key is set for this creator. The plain value is no
                    longer accessible — regenerate to issue a new one
                    (immediately invalidates the previous key).
                  </span>
                ) : (
                  <span className="text-amber-500">
                    No API key has been issued yet. Generating one will allow
                    this creator to authenticate against the external endpoints.
                  </span>
                )}
              </div>
            )}

            {showingFreshKey && plainKey && (
              <div className="space-y-2">
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-500">
                  <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                  <div className="leading-snug">
                    Copy this key now — it won&apos;t be shown again. Only the
                    SHA-256 hash is stored on our side.
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    API key
                  </div>
                  <div className="flex items-stretch gap-2">
                    <code className="flex-1 select-all break-all rounded-md border bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed">
                      {plainKey}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={handleCopy}
                      aria-label="Copy API key"
                      className="shrink-0"
                    >
                      {copied ? (
                        <Check className="size-4 text-emerald-500" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                    </Button>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    Send via the <code className="font-mono">X-API-Key</code>{" "}
                    header.
                  </div>
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <DialogClose
              render={
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={isPending}
                />
              }
            >
              {showingFreshKey ? "Done" : "Close"}
            </DialogClose>
            {status.state === "loaded" && (
              <Button
                type="button"
                onClick={onRotateClick}
                disabled={isPending}
                className="w-full sm:w-auto"
              >
                {isPending ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    {(() => {
                      const Icon = rotateButtonIcon;
                      return <Icon className="mr-1.5 size-3.5" />;
                    })()}
                    {rotateButtonLabel}
                  </>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate API key?</AlertDialogTitle>
            <AlertDialogDescription>
              The current key will stop working immediately. Any external
              client (widget, OBS overlay, integration) still using it will
              start receiving 401 responses until updated with the new key.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmRotate(false);
                performRotate();
              }}
              disabled={isPending}
            >
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
