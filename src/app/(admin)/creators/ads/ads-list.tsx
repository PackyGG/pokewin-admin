"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowRight,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  formatCurrency,
  formatNumber,
  formatRelative,
} from "@/lib/utils/format";
import type { AdCodeSummary } from "@/lib/queries/ads";
import { createAdCode, deleteAdCode } from "./actions";

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

      <div className="rounded-2xl border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Signups</TableHead>
              <TableHead className="text-right">Depositors</TableHead>
              <TableHead className="text-right">Conv.</TableHead>
              <TableHead className="text-right">Deposits</TableHead>
              <TableHead className="text-right">Wagers</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[60px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((c) => (
              <TableRow key={c.code} className="group">
                <TableCell>
                  <Link
                    href={`/creators/ads/${encodeURIComponent(c.code)}`}
                    className="inline-flex items-center gap-2 font-mono text-sm hover:underline"
                  >
                    <Badge variant="outline" className="font-mono">
                      {c.code}
                    </Badge>
                    <ArrowRight className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(c.clicks)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(c.signups)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(c.depositors)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {c.clicks > 0
                    ? `${(c.conversionRate * 100).toFixed(1)}%`
                    : "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(c.depositVolumeUsd)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(c.wagerVolumeUsd)}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatRelative(c.createdAt)}
                </TableCell>
                <TableCell className="text-right">
                  <DeleteCodeButton code={c.code} />
                </TableCell>
              </TableRow>
            ))}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="h-32 text-center text-sm text-muted-foreground"
                >
                  {codes.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 py-4">
                      <MousePointerClick className="size-6 text-muted-foreground/60" />
                      <p>No ad codes yet. Create one to get started.</p>
                    </div>
                  ) : (
                    "No codes match your search."
                  )}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

export function CreateAdCodeButton() {
  const router = useRouter();
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
        router.refresh();
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
            <Label htmlFor="ad-code">Code</Label>
            <Input
              id="ad-code"
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
// Delete (with confirm)
// ---------------------------------------------------------------------------

function DeleteCodeButton({ code }: { code: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      try {
        await deleteAdCode(code);
        toast.success("Ad code deleted");
        setOpen(false);
        router.refresh();
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
        onClick={() => setOpen(true)}
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

