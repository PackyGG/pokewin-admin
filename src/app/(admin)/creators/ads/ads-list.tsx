"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  Copy,
  Megaphone,
  MousePointerClick,
  Plus,
  Search,
  Trash2,
  UserPlus,
  ArrowDownToLine,
  Coins,
  Percent,
  Calendar,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
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
import { Badge } from "@/components/ui/badge";
import {
  formatCurrency,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import type { AdCodeSummary } from "@/lib/queries/ads";
import { createAdCode, deleteAdCode } from "./actions";
import { getAdLink } from "./ad-link";

export function AdsList({ codes }: { codes: AdCodeSummary[] }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return codes;
    return codes.filter((c) => c.code.toLowerCase().includes(q));
  }, [codes, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search codes..."
            className="pl-9"
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {formatNumber(filtered.length)}{" "}
          {filtered.length === 1 ? "code" : "codes"}
        </p>
      </div>

      {filtered.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 rounded-2xl border bg-muted/20 text-sm text-muted-foreground">
          {codes.length === 0 ? (
            <>
              <MousePointerClick className="size-6 text-muted-foreground/60" />
              <p>No ad codes yet. Create one to get started.</p>
            </>
          ) : (
            "No codes match your search."
          )}
        </div>
      ) : (
        // Card grid — 1 / 2 / 3 / 4 cols matching the /creators page
        // aesthetic. Each card is self-contained: header row with the
        // code badge + actions, then four metric cells (Clicks, Signups,
        // Deposits, Wagers), then a footer with conversion + created.
        <div className="grid gap-3 grid-cols-1 sm:gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((c) => (
            <AdCodeCard key={c.code} code={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function AdCodeCard({ code: c }: { code: AdCodeSummary }) {
  const router = useRouter();
  const detailHref = `/creators/ads/${encodeURIComponent(c.code)}`;
  const convPct =
    c.clicks > 0 ? `${(c.conversionRate * 100).toFixed(1)}%` : "—";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => router.push(detailHref)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          router.push(detailHref);
        }
      }}
      className="group relative cursor-pointer overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-card/70 p-4 transition-colors hover:border-purple-500/30 sm:p-5"
    >
      {/* corner glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-purple-500/[0.08] blur-2xl"
      />

      <div className="relative space-y-4">
        {/* HEADER */}
        <div className="flex items-start gap-2">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-purple-500/15">
            <Megaphone className="size-5 text-purple-500" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant="outline"
                className="bg-purple-500/15 border-purple-500/30 text-purple-700 dark:text-purple-300 font-mono"
              >
                {c.code}
              </Badge>
            </div>
            <p className="mt-0.5 flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <Calendar className="size-2.5 shrink-0" />
              Created {formatRelative(c.createdAt)}
            </p>
          </div>
          <div
            className="flex shrink-0 items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <CopyLinkButton code={c.code} />
            <DeleteCodeButton code={c.code} />
          </div>
        </div>

        {/* METRICS — 2x2 grid of compact tiles */}
        <div className="grid grid-cols-2 gap-2">
          <MetricCell
            icon={MousePointerClick}
            label="Clicks"
            value={formatNumber(c.clicks)}
          />
          <MetricCell
            icon={UserPlus}
            label="Signups"
            value={formatNumber(c.signups)}
            sub={
              c.activeReferrals > 0
                ? `${formatNumber(c.activeReferrals)} active`
                : undefined
            }
          />
          {/* Deposits: money INTO the house → emerald (house gain). */}
          <MetricCell
            icon={ArrowDownToLine}
            label="Deposits"
            value={formatCurrency(c.depositVolumeUsd)}
            valueClass="text-emerald-600 dark:text-emerald-400"
            sub={
              c.depositors > 0
                ? `${formatNumber(c.depositors)} depositor${
                    c.depositors === 1 ? "" : "s"
                  }`
                : undefined
            }
          />
          <MetricCell
            icon={Coins}
            label="Wagers"
            value={formatCurrency(c.wagerVolumeUsd)}
            valueClass="text-emerald-600 dark:text-emerald-400"
          />
        </div>

        {/* FOOTER — conversion + FTD line */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Percent className="size-3" />
            <span>
              <span className="font-mono font-semibold tabular-nums text-foreground">
                {convPct}
              </span>{" "}
              click → signup
            </span>
          </div>
          {c.ftdVolumeUsd > 0 && (
            <div className="text-[11px] text-muted-foreground">
              FTD{" "}
              <span className="font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(c.ftdVolumeUsd)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCell({
  icon: Icon,
  label,
  value,
  sub,
  valueClass,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-background/50 px-3 py-2">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3" />
        {label}
      </div>
      <p
        className={
          "mt-0.5 truncate text-sm font-semibold tabular-nums " +
          (valueClass ?? "")
        }
      >
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
          {sub}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

export function CreateAdCodeButton() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!code.trim()) {
      toast.error("Code cannot be empty");
      return;
    }
    startTransition(async () => {
      try {
        await createAdCode(code);
        toast.success("Ad code created");
        setCode("");
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to create code");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="mr-1 size-4" />
            Create Ad Code
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Ad Code</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="campaign-code">Code</Label>
            {/* id/htmlFor intentionally do NOT contain "ad" — generic
                adblocker filter rules (uBlock Origin, Brave Shields)
                hide any element with id matching `#ad-*`, which meant
                users with those extensions saw an empty dialog. Don't
                reintroduce "ad" in form-field ids on this page. */}
            <Input
              id="campaign-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="e.g. SPRING24"
              autoFocus
              maxLength={20}
            />
            <p className="text-xs text-muted-foreground">
              2–20 characters. Letters, numbers, dashes and underscores only.
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Copy ad link
// ---------------------------------------------------------------------------

function CopyLinkButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    // Prevent the row-level click from navigating to the detail page.
    e.stopPropagation();
    const link = getAdLink(code);
    navigator.clipboard
      .writeText(link)
      .then(() => {
        setCopied(true);
        toast.success("Link copied", { description: link });
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        toast.error("Couldn't copy link");
      });
  }

  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8 text-muted-foreground hover:text-foreground"
      onClick={handleCopy}
      aria-label={`Copy link for ${code}`}
      title={`Copy link for ${code}`}
    >
      {copied ? (
        <Check className="size-4 text-emerald-500" />
      ) : (
        <Copy className="size-4" />
      )}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Delete (with confirm)
// ---------------------------------------------------------------------------

function DeleteCodeButton({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      try {
        await deleteAdCode(code);
        toast.success("Ad code deleted");
        setOpen(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to delete");
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="icon"
        variant="ghost"
        className="size-8 text-muted-foreground hover:text-rose-500"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Delete ${code}`}
      >
        <Trash2 className="size-4" />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete ad code?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the <span className="font-mono">{code}</span> code.
            Historical clicks, signups, and deposit usages are kept — they&apos;re
            stored under the house account — but new clicks on the link will
            no longer attribute.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={pending}
            className="bg-rose-500 hover:bg-rose-600 focus:ring-rose-500"
          >
            {pending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

