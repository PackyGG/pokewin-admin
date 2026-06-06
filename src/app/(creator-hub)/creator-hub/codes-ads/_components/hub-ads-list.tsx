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
import {
  formatCurrency,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import type { AdCodeSummary } from "@/lib/queries/ads";
import { EmptyState } from "@/components/empty-state";
import { getAdLink } from "@/app/(admin)/creators/ads/ad-link";
import { createAdCode, deleteAdCode } from "../actions";

export function HubAdsList({ codes }: { codes: AdCodeSummary[] }) {
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
        <div className="rounded-2xl border bg-muted/20">
          {codes.length === 0 ? (
            <EmptyState
              icon={MousePointerClick}
              title="No ad codes yet"
              description="Create your first campaign code to start tracking clicks, signups, and deposits."
            />
          ) : (
            <EmptyState
              icon={Search}
              title="No codes match your search"
              description="Try a different campaign code."
            />
          )}
        </div>
      ) : (
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
      className="group relative cursor-pointer overflow-hidden rounded-2xl border border-border/60 bg-card p-5 transition-all hover:-translate-y-px hover:border-border hover:shadow-lg sm:p-6"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 -top-16 size-40 rounded-full bg-purple-500/0 blur-3xl transition-colors duration-500 group-hover:bg-purple-500/[0.10]"
      />

      <div className="relative space-y-5">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-purple-500/10 text-purple-500 transition-colors group-hover:bg-purple-500/15">
            <Megaphone className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p
              className="truncate font-mono text-base font-semibold tracking-wide"
              title={c.code}
            >
              {c.code}
            </p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              Created {formatRelative(c.createdAt)}
            </p>
          </div>
          <div
            className="-mr-1 -mt-1 flex shrink-0 items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <CopyLinkButton code={c.code} />
            <DeleteCodeButton code={c.code} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-3 sm:grid-cols-4 sm:divide-x sm:divide-border/60">
          <AdStat label="Clicks">
            <span className="block truncate text-sm font-semibold tabular-nums">
              {c.clicks > 0 ? formatNumber(c.clicks) : "—"}
            </span>
          </AdStat>
          <AdStat
            label="Signups"
            trailing={
              c.activeReferrals > 0 ? (
                <span className="font-mono normal-case text-[10px] text-muted-foreground/70">
                  {formatNumber(c.activeReferrals)} act
                </span>
              ) : null
            }
          >
            <span className="block truncate text-sm font-semibold tabular-nums">
              {c.signups > 0 ? formatNumber(c.signups) : "—"}
            </span>
          </AdStat>
          <AdStat
            label="Deposits"
            trailing={
              c.depositors > 0 ? (
                <span className="font-mono normal-case text-[10px] text-muted-foreground/70">
                  {formatNumber(c.depositors)} u
                </span>
              ) : null
            }
          >
            <span className="block truncate text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {c.depositVolumeUsd > 0
                ? formatCurrency(c.depositVolumeUsd)
                : "—"}
            </span>
          </AdStat>
          <AdStat label="Wagers">
            <span className="block truncate text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {c.wagerVolumeUsd > 0 ? formatCurrency(c.wagerVolumeUsd) : "—"}
            </span>
          </AdStat>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-4 text-[11px]">
          <div className="text-muted-foreground">
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {convPct}
            </span>{" "}
            click → signup
          </div>
          {c.ftdVolumeUsd > 0 && (
            <div className="text-muted-foreground">
              FTD{" "}
              <span className="font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                {formatCurrency(c.ftdVolumeUsd)}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AdStat({
  label,
  children,
  trailing,
}: {
  label: string;
  children: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 sm:px-3 sm:first:pl-0 sm:last:pr-0">
      <div className="flex items-center justify-between gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span>{label}</span>
        {trailing}
      </div>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function HubCreateAdCodeButton() {
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
            <Label htmlFor="hub-campaign-code">Code</Label>
            <Input
              id="hub-campaign-code"
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

function CopyLinkButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
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
