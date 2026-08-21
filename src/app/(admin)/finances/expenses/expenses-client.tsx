"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarDays,
  CircleDollarSign,
  Loader2,
  Pencil,
  Plus,
  Receipt,
  Search,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  createExpense,
  deleteExpense,
  updateExpense,
  type ExpenseInput,
} from "@/app/(admin)/finances/actions";
import {
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  expenseCategoryLabel,
  paymentMethodLabel,
} from "@/app/(admin)/finances/cost-constants";
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
import { Textarea } from "@/components/ui/textarea";
import { formatCurrency } from "@/lib/utils/format";
import type {
  ExpenseListItem,
  ExpensePageData,
} from "@/lib/queries/finance-costs";

const EMPTY_EXPENSE: ExpenseInput = {
  description: "",
  amount: 0,
  date: new Date().toISOString().slice(0, 10),
  paidTo: "",
  paidBy: "",
  paymentMethod: "bank_transfer",
  category: "software",
  notes: "",
};

function expenseInput(item: ExpenseListItem): ExpenseInput {
  return {
    description: item.description,
    amount: item.amount,
    date: item.date,
    paidTo: item.paidTo,
    paidBy: item.paidBy ?? "",
    paymentMethod: item.paymentMethod,
    category: item.category,
    notes: item.notes ?? "",
  };
}

function ExpenseDialog({ item }: { item?: ExpenseListItem }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ExpenseInput>(() =>
    item ? expenseInput(item) : EMPTY_EXPENSE,
  );
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (!open) return;
    setForm(
      item
        ? expenseInput(item)
        : { ...EMPTY_EXPENSE, date: new Date().toISOString().slice(0, 10) },
    );
  }, [item, open]);

  const valid =
    form.description.trim() &&
    form.amount > 0 &&
    form.date &&
    form.paidTo.trim() &&
    form.category.trim();

  function submit() {
    startTransition(async () => {
      try {
        const result = item
          ? await updateExpense(item.id, form)
          : await createExpense(form);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success(item ? "Expense updated" : "Expense added");
        setOpen(false);
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Expense could not be saved",
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
              aria-label={`Edit ${item.description}`}
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
            Add expense
          </>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto p-0 sm:max-w-2xl">
        <div className="border-b bg-card px-5 py-4">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-rose-500/10">
                <Receipt className="size-4 text-rose-500" />
              </div>
              <div>
                <DialogTitle>
                  {item ? "Edit expense" : "Add one-time expense"}
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Record a completed operational payment.
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        <div className="grid gap-4 px-5 py-5 sm:grid-cols-2">
          <Field
            label="Description"
            htmlFor="expense-description"
            className="sm:col-span-2"
          >
            <Input
              id="expense-description"
              value={form.description}
              onChange={(event) =>
                setForm({ ...form, description: event.target.value })
              }
              placeholder="e.g. Annual legal filing"
              maxLength={200}
            />
          </Field>
          <Field label="Amount (USD)" htmlFor="expense-amount">
            <Input
              id="expense-amount"
              type="number"
              min="0.01"
              step="0.01"
              value={form.amount || ""}
              onChange={(event) =>
                setForm({ ...form, amount: Number(event.target.value) })
              }
              placeholder="0.00"
            />
          </Field>
          <Field label="Payment date" htmlFor="expense-date">
            <Input
              id="expense-date"
              type="date"
              value={form.date}
              onChange={(event) =>
                setForm({ ...form, date: event.target.value })
              }
            />
          </Field>
          <Field label="Paid to" htmlFor="expense-paid-to">
            <Input
              id="expense-paid-to"
              value={form.paidTo}
              onChange={(event) =>
                setForm({ ...form, paidTo: event.target.value })
              }
              placeholder="Vendor or recipient"
              maxLength={160}
            />
          </Field>
          <Field label="Paid by" htmlFor="expense-paid-by">
            <Input
              id="expense-paid-by"
              value={form.paidBy ?? ""}
              onChange={(event) =>
                setForm({ ...form, paidBy: event.target.value })
              }
              placeholder="Optional"
              maxLength={160}
            />
          </Field>
          <Field label="Payment method" htmlFor="expense-payment-method">
            <Select
              value={form.paymentMethod}
              onValueChange={(value) =>
                value && setForm({ ...form, paymentMethod: value })
              }
            >
              <SelectTrigger id="expense-payment-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((method) => (
                  <SelectItem key={method.value} value={method.value}>
                    {method.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Category" htmlFor="expense-category">
            <Input
              id="expense-category"
              list="expense-categories"
              value={form.category}
              onChange={(event) =>
                setForm({ ...form, category: event.target.value })
              }
              placeholder="Choose or type a category"
              maxLength={80}
            />
            <datalist id="expense-categories">
              {EXPENSE_CATEGORIES.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.label}
                </option>
              ))}
            </datalist>
          </Field>
          <Field
            label="Notes"
            htmlFor="expense-notes"
            className="sm:col-span-2"
          >
            <Textarea
              id="expense-notes"
              value={form.notes ?? ""}
              onChange={(event) =>
                setForm({ ...form, notes: event.target.value })
              }
              placeholder="Invoice reference or context (optional)"
              maxLength={2000}
              rows={3}
            />
          </Field>
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
            {isPending ? "Saving…" : item ? "Save changes" : "Add expense"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function DeleteExpenseButton({ item }: { item: ExpenseListItem }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function remove() {
    startTransition(async () => {
      try {
        const result = await deleteExpense(item.id);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Expense deleted");
        router.refresh();
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Expense could not be deleted",
        );
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            disabled={isPending}
            aria-label={`Delete ${item.description}`}
            className="text-muted-foreground hover:text-destructive"
          />
        }
      >
        {isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Trash2 className="size-4" />
        )}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this expense?</AlertDialogTitle>
          <AlertDialogDescription>
            “{item.description}” for {formatCurrency(item.amount)} will be
            permanently removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={remove}>
            Delete expense
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ExpensesClient({ data }: { data: ExpensePageData }) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const categories = useMemo(
    () => [...new Set(data.items.map((item) => item.category))].sort(),
    [data.items],
  );
  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return data.items.filter((item) => {
      if (category !== "all" && item.category !== category) return false;
      if (!query) return true;
      return [
        item.description,
        item.paidTo,
        item.paidBy,
        item.notes,
        item.category,
      ].some((value) => value?.toLowerCase().includes(query));
    });
  }, [category, data.items, search]);

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="This month"
          value={formatCurrency(data.summary.thisMonth)}
          icon={CalendarDays}
          tone="rose"
        />
        <SummaryCard
          label="All-time expenses"
          value={formatCurrency(data.summary.total)}
          icon={CircleDollarSign}
          tone="amber"
        />
        <SummaryCard
          label="Entries"
          value={data.summary.count.toLocaleString()}
          icon={Receipt}
          tone="blue"
        />
        <SummaryCard
          label="Top category"
          value={
            data.summary.topCategory
              ? expenseCategoryLabel(data.summary.topCategory)
              : "No expenses"
          }
          icon={Receipt}
          tone="purple"
        />
      </div>

      <Card>
        <CardHeader className="gap-4 border-b lg:flex-row lg:items-center lg:justify-between">
          <div>
            <CardTitle>Expense ledger</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              One-time payments, newest first.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="Search expenses"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search expenses…"
                className="pl-9 sm:w-64"
              />
            </div>
            <Select
              value={category}
              onValueChange={(value) => value && setCategory(value)}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((item) => (
                  <SelectItem key={item} value={item}>
                    {expenseCategoryLabel(item)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ExpenseDialog />
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filtered.length ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Expense</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="hidden lg:table-cell">
                      Payment
                    </TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead className="w-20" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {item.date}
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{item.description}</p>
                        <p className="max-w-72 truncate text-xs text-muted-foreground">
                          Paid to {item.paidTo}
                          {item.notes ? ` · ${item.notes}` : ""}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {expenseCategoryLabel(item.category)}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
                        {paymentMethodLabel(item.paymentMethod)}
                        {item.paidBy ? ` · ${item.paidBy}` : ""}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                        −{formatCurrency(item.amount)}
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end">
                          <ExpenseDialog item={item} />
                          <DeleteExpenseButton item={item} />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="flex min-h-56 flex-col items-center justify-center gap-2 px-6 text-center">
              <div className="flex size-11 items-center justify-center rounded-xl bg-muted">
                <Receipt className="size-5 text-muted-foreground" />
              </div>
              <p className="font-medium">
                {data.items.length ? "No matching expenses" : "No expenses yet"}
              </p>
              <p className="text-sm text-muted-foreground">
                {data.items.length
                  ? "Try a different search or category."
                  : "Add the first one-time expense to start the ledger."}
              </p>
              {!data.items.length && (
                <div className="mt-2">
                  <ExpenseDialog />
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
  tone: "rose" | "amber" | "blue" | "purple";
}) {
  const colors = {
    rose: "bg-rose-500/10 text-rose-500",
    amber: "bg-amber-500/10 text-amber-500",
    blue: "bg-blue-500/10 text-blue-500",
    purple: "bg-purple-500/10 text-purple-500",
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
