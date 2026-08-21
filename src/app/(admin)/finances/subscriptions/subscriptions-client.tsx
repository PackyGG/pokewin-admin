"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  CircleDollarSign,
  Loader2,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  createSubscription,
  deleteSubscription,
  toggleSubscription,
  updateSubscription,
  type SubscriptionInput,
} from "@/app/(admin)/finances/actions";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  SubscriptionListItem,
  SubscriptionPageData,
} from "@/lib/queries/finance-costs";
import { formatCurrency } from "@/lib/utils/format";

const EMPTY_SUBSCRIPTION: SubscriptionInput = {
  name: "",
  amount: 0,
};

function subscriptionInput(item: SubscriptionListItem): SubscriptionInput {
  return {
    name: item.name,
    amount: item.amount,
  };
}

function SubscriptionDialog({ item }: { item?: SubscriptionListItem }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<SubscriptionInput>(() =>
    item ? subscriptionInput(item) : EMPTY_SUBSCRIPTION,
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (open) setForm(item ? subscriptionInput(item) : EMPTY_SUBSCRIPTION);
  }, [item, open]);

  const valid = form.name.trim() && form.amount > 0;

  function submit() {
    startTransition(async () => {
      try {
        const result = item
          ? await updateSubscription(item.id, form)
          : await createSubscription(form);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success(item ? "Subscription updated" : "Subscription added");
        setOpen(false);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Subscription could not be saved",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          item ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Edit ${item.name}`}
            />
          ) : (
            <Button size="sm" />
          )
        }
      >
        {item ? (
          <Pencil className="size-4" />
        ) : (
          <>
            <Plus className="size-4" />
            Add subscription
          </>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-xl">
        <div className="border-b bg-card px-5 py-4">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-violet-500/10">
                <CalendarClock className="size-4 text-violet-500" />
              </div>
              <div>
                <DialogTitle>
                  {item ? "Edit subscription" : "Add subscription"}
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Track a recurring monthly commitment.
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="subscription-name">Name</Label>
            <Input
              id="subscription-name"
              value={form.name}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              placeholder="e.g. Sentry Business"
              maxLength={160}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="subscription-amount">Monthly amount (USD)</Label>
            <Input
              id="subscription-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={form.amount || ""}
              onChange={(event) =>
                setForm({ ...form, amount: Number(event.target.value) })
              }
              placeholder="0.00"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || !valid}>
            {isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : item ? (
              <Pencil className="size-4" />
            ) : (
              <Plus className="size-4" />
            )}
            {isPending ? "Saving…" : item ? "Save changes" : "Add subscription"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SubscriptionActions({ item }: { item: SubscriptionListItem }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function toggle() {
    startTransition(async () => {
      try {
        const result = await toggleSubscription(item.id, !item.isActive);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success(
          item.isActive ? "Subscription paused" : "Subscription activated",
        );
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Subscription status could not be changed",
        );
      }
    });
  }

  function remove() {
    startTransition(async () => {
      try {
        const result = await deleteSubscription(item.id);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Subscription deleted");
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Subscription could not be deleted",
        );
      }
    });
  }

  return (
    <div className="flex justify-end">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggle}
        disabled={isPending}
        aria-label={
          item.isActive ? `Pause ${item.name}` : `Activate ${item.name}`
        }
      >
        {isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : item.isActive ? (
          <PauseCircle className="size-4" />
        ) : (
          <PlayCircle className="size-4" />
        )}
      </Button>
      <SubscriptionDialog item={item} />
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              disabled={isPending}
              aria-label={`Delete ${item.name}`}
              className="text-muted-foreground hover:text-destructive"
            />
          }
        >
          <Trash2 className="size-4" />
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this subscription?</AlertDialogTitle>
            <AlertDialogDescription>
              “{item.name}” will be permanently removed from recurring costs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete subscription
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function SubscriptionsClient({ data }: { data: SubscriptionPageData }) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.items.filter((item) => {
      if (status === "active" && !item.isActive) return false;
      if (status === "paused" && item.isActive) return false;
      return !query || item.name.toLowerCase().includes(query);
    });
  }, [data.items, search, status]);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Monthly commitments"
          value={formatCurrency(data.summary.activeMonthly)}
          icon={CircleDollarSign}
          tone="violet"
        />
        <SummaryCard
          label="Annual run rate"
          value={formatCurrency(data.summary.annualRunRate)}
          icon={CalendarClock}
          tone="amber"
        />
        <SummaryCard
          label="Active"
          value={data.summary.activeCount.toLocaleString()}
          icon={PlayCircle}
          tone="emerald"
        />
        <SummaryCard
          label="Paused"
          value={data.summary.inactiveCount.toLocaleString()}
          icon={PauseCircle}
          tone="slate"
        />
      </div>

      <Card>
        <CardHeader className="gap-4 border-b lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>Subscriptions</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Monthly recurring costs and software commitments.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search subscriptions"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search subscriptions…"
                className="pl-9 sm:w-64"
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) => value && setStatus(value)}
            >
              <SelectTrigger className="w-full sm:w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
              </SelectContent>
            </Select>
            <SubscriptionDialog />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subscription</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Monthly</TableHead>
                    <TableHead className="hidden text-right md:table-cell">
                      Annual
                    </TableHead>
                    <TableHead className="w-28" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((item) => (
                    <TableRow
                      key={item.id}
                      className={!item.isActive ? "opacity-60" : undefined}
                    >
                      <TableCell>
                        <p className="font-medium">{item.name}</p>
                        <p className="text-xs text-muted-foreground">
                          Added by {item.createdBy}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={item.isActive ? "default" : "outline"}>
                          {item.isActive ? "Active" : "Paused"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatCurrency(item.amount)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
                        {formatCurrency(item.amount * 12)}
                      </TableCell>
                      <TableCell>
                        <SubscriptionActions item={item} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 text-center">
              <div className="flex size-11 items-center justify-center rounded-xl bg-muted">
                <CalendarClock className="size-5 text-muted-foreground" />
              </div>
              <p className="font-medium">
                {data.items.length
                  ? "No matching subscriptions"
                  : "No subscriptions yet"}
              </p>
              <p className="text-sm text-muted-foreground">
                {data.items.length
                  ? "Try a different search or status."
                  : "Add the first monthly commitment to start tracking run rate."}
              </p>
              {!data.items.length && (
                <div className="mt-2">
                  <SubscriptionDialog />
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  tone: "violet" | "amber" | "emerald" | "slate";
}) {
  const colors = {
    violet: "bg-violet-500/10 text-violet-500",
    amber: "bg-amber-500/10 text-amber-500",
    emerald: "bg-emerald-500/10 text-emerald-500",
    slate: "bg-muted text-muted-foreground",
  };
  return (
    <Card className="shadow-sm">
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${colors[tone]}`}
        >
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-lg font-semibold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}
