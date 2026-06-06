"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Search, Tv, Twitter } from "lucide-react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ux";

import { runCheck } from "../actions";

/**
 * "+ Check Creator" dialog (Creator Check tool).
 *
 * Asks for a Kick username + a Twitter username — BOTH optional, but at least
 * one required (owner spec). On submit it calls the `runCheck` server action,
 * which fetches ALL available data from both APIs (server-only keys), saves it
 * to the ADMIN-DB substrate, and returns a per-platform outcome. We surface
 * that as a toast, then `router.refresh()` so the new/updated profile boxes
 * render from the saved rows.
 *
 * Works for ANY handle — this is a recon lookup, not limited to signed-up
 * creators. Follows the house client pattern (try/catch → sonner, useTransition
 * for pending, shadcn primitives).
 */
export function CheckCreatorDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kick, setKick] = useState("");
  const [twitter, setTwitter] = useState("");
  const [pending, startTransition] = useTransition();

  const canSubmit = kick.trim().length > 0 || twitter.trim().length > 0;

  function reset() {
    setKick("");
    setTwitter("");
  }

  function handleSubmit() {
    if (!canSubmit) {
      toast.error("Enter a Kick username, a Twitter username, or both.");
      return;
    }
    startTransition(async () => {
      try {
        const res = await runCheck({
          kick: kick.trim() || null,
          twitter: twitter.trim() || null,
        });
        if (!res.success) {
          toast.error(res.error);
          return;
        }

        // Build an honest, specific result message per platform.
        const parts: string[] = [];
        if (res.kick.handle) {
          if (res.kick.noKey) parts.push("Kick: no API key set");
          else if (res.kick.found) parts.push(`Kick: @${res.kick.handle} ✓`);
          else if (res.kick.staleError) parts.push("Kick: fetch failed");
          else parts.push(`Kick: @${res.kick.handle} not found`);
        }
        if (res.twitter.handle) {
          if (res.twitter.noKey) parts.push("Twitter: no API key set");
          else if (res.twitter.found)
            parts.push(`Twitter: @${res.twitter.handle} ✓`);
          else if (res.twitter.staleError) parts.push("Twitter: fetch failed");
          else parts.push(`Twitter: @${res.twitter.handle} not found`);
        }
        const msg = parts.join(" · ");

        if (res.anyFound) {
          toast.success(msg || "Check complete.");
        } else {
          // Nothing resolved — still not an error (could be unknown handles or
          // a missing key); show a warning-style toast with the detail.
          toast.warning(msg || "No profiles found for those handles.");
        }

        reset();
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to run the check.",
        );
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Don't allow closing mid-request so the in-flight fetch isn't orphaned.
        if (pending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button className="gap-1.5" />}>
        <Plus className="size-4" />
        Check Creator
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-600 ring-1 ring-inset ring-cyan-500/30 dark:text-cyan-400">
              <Search className="size-4" />
            </span>
            Check a creator
          </DialogTitle>
          <DialogDescription>
            Look up any Kick and/or Twitter handle. We pull their public
            profile, latest streams, and latest tweets, then save them here.
            At least one handle is required.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Kick */}
          <div className="space-y-1.5">
            <Label htmlFor="check-kick" className="flex items-center gap-1.5">
              <Tv className="size-3.5 text-emerald-500" />
              Kick username
              <span className="text-xs font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="check-kick"
              value={kick}
              onChange={(e) => setKick(e.target.value)}
              placeholder="e.g. trainwreckstv"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit && !pending) handleSubmit();
              }}
            />
          </div>

          {/* Twitter */}
          <div className="space-y-1.5">
            <Label htmlFor="check-twitter" className="flex items-center gap-1.5">
              <Twitter className="size-3.5 text-sky-500" />
              Twitter / X username
              <span className="text-xs font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Input
              id="check-twitter"
              value={twitter}
              onChange={(e) => setTwitter(e.target.value)}
              placeholder="e.g. packydotgg"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit && !pending) handleSubmit();
              }}
            />
          </div>

          <p className="text-[11px] text-muted-foreground">
            You can paste a profile URL too — we&apos;ll extract the handle.
            Data is served from our database and only refreshed on demand (no
            background polling).
          </p>
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={pending || !canSubmit}
            className="gap-1.5"
          >
            {pending ? <Spinner size={14} /> : <Search className="size-4" />}
            {pending ? "Checking…" : "Run check"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
