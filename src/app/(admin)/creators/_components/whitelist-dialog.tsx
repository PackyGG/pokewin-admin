"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, ShieldCheck, Plus } from "lucide-react";

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
import { Button } from "@/components/ui/button";

import {
  getWhitelist,
  saveWhitelist,
} from "../cloudflare-whitelist-actions";
import { parseList } from "../_lib/cloudflare-whitelist";

type Status =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded" }
  | { state: "error"; message: string };

export function WhitelistDialog() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Status>({ state: "idle" });
  const [ips, setIps] = useState("");
  const [keys, setKeys] = useState("");
  const [isPending, startTransition] = useTransition();

  // Load the live rule each time the dialog opens — Cloudflare is the source
  // of truth, so we never trust stale local state.
  useEffect(() => {
    if (!open) {
      setStatus({ state: "idle" });
      setIps("");
      setKeys("");
      return;
    }
    let cancelled = false;
    setStatus({ state: "loading" });
    (async () => {
      try {
        const wl = await getWhitelist();
        if (cancelled) return;
        setIps(wl.ips.join("\n"));
        setKeys(wl.keys.join("\n"));
        setStatus({ state: "loaded" });
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
  }, [open]);

  function handleSave() {
    startTransition(async () => {
      try {
        const saved = await saveWhitelist({
          ips: parseList(ips),
          keys: parseList(keys),
        });
        setIps(saved.ips.join("\n"));
        setKeys(saved.keys.join("\n"));
        toast.success(
          `Whitelist saved — ${saved.ips.length} IPs, ${saved.keys.length} keys`,
        );
        setOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to save whitelist",
        );
      }
    });
  }

  // Native v4 UUID — same thing the codepen generator does, no external site.
  // Append it on its own line (ready to save) and copy it to the clipboard so
  // it can be handed to the creator immediately.
  async function generateKey() {
    const id = crypto.randomUUID();
    setKeys((prev) => (prev.trim() ? `${prev.replace(/\s*$/, "")}\n${id}` : id));
    try {
      await navigator.clipboard.writeText(id);
      toast.success(`Key generated & copied — ${id}`);
    } catch {
      toast.success(`Key generated — ${id} (copy it manually)`);
    }
  }

  const ipCount = parseList(ips).length;
  const keyCount = parseList(keys).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <ShieldCheck className="mr-1.5 size-3.5" />
        Whitelist
      </DialogTrigger>

      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Affiliate Stats Whitelist</DialogTitle>
          <DialogDescription>
            Cloudflare WAF skip-rule for{" "}
            <code className="font-mono">/v1/affiliate/stats</code>. Requests
            from a listed source IP <em>or</em> bearing a listed{" "}
            <code className="font-mono">x-custom-key</code> header bypass rate
            limiting + bot protection. Saving writes straight to Cloudflare.
          </DialogDescription>
        </DialogHeader>

        {status.state === "loading" && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading rule from Cloudflare…
          </div>
        )}

        {status.state === "error" && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            {status.message}
          </div>
        )}

        {status.state === "loaded" && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                Source IPs / CIDRs ({ipCount})
              </label>
              <textarea
                value={ips}
                onChange={(e) => setIps(e.target.value)}
                disabled={isPending}
                spellCheck={false}
                rows={6}
                placeholder="One per line — e.g. 1.2.3.4 or 2a02:4780::/32"
                className="w-full resize-y rounded-md border bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  x-custom-key values ({keyCount})
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={generateKey}
                  disabled={isPending}
                  className="h-6 px-2 text-[11px]"
                >
                  <Plus className="mr-1 size-3" />
                  Generate key
                </Button>
              </div>
              <textarea
                value={keys}
                onChange={(e) => setKeys(e.target.value)}
                disabled={isPending}
                spellCheck={false}
                rows={6}
                placeholder="One per line — UUID keys you handed to creators"
                className="w-full resize-y rounded-md border bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          </div>
        )}

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
            Cancel
          </DialogClose>
          {status.state === "loaded" && (
            <Button
              type="button"
              onClick={handleSave}
              disabled={isPending}
              className="w-full sm:w-auto"
            >
              {isPending ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save to Cloudflare"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
