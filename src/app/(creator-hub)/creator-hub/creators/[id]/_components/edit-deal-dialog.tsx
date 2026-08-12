"use client";

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ux";
import type { CreatorDealResponse } from "@/lib/backend-api";

import { updateCreatorDeal } from "../../../../../(admin)/creators/backend-actions";
import {
  buildDefaultsFromDeal,
  dealFormSchema,
  DealFormFields,
  toDealPayload,
  type DealFormState,
} from "./deal-form-shared";

type Props = {
  userId: string;
  deal: CreatorDealResponse;
  /** Controlled — opened from the deal overflow menu (no own trigger). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Creator Hub — "Edit terms" dialog.
 *
 * Edits the creator's CURRENT ACTIVE deal via the existing
 * `updateCreatorDeal` server action (optimistic concurrency on
 * `deal.version`). The schema + field grid live in `deal-form-shared.tsx`
 * (shared with New Deal); this dialog keeps only the update submit path.
 * Controlled by the deal actions overflow menu.
 */
export function EditDealDialog({ userId, deal, open, onOpenChange }: Props) {
  const formId = useId();
  const router = useRouter();
  const [form, setForm] = useState<DealFormState>(() =>
    buildDefaultsFromDeal(deal),
  );
  const [pending, startTransition] = useTransition();

  // Re-seed from the live deal terms each time the dialog opens.
  useEffect(() => {
    if (open) setForm(buildDefaultsFromDeal(deal));
  }, [open, deal]);

  function handleOpenChange(next: boolean) {
    if (pending) return;
    onOpenChange(next);
  }

  function update<K extends keyof DealFormState>(
    key: K,
    value: DealFormState[K],
  ) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = dealFormSchema.safeParse(form);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid deal input");
      return;
    }
    const payload = toDealPayload(parsed.data);
    if (!payload) {
      toast.error("Enter valid start and end dates");
      return;
    }
    const { withdraw_cap_period_days: _withdrawCapPeriodDays, ...patch } = payload;

    startTransition(async () => {
      try {
        await updateCreatorDeal(userId, deal.id, deal.version, patch);
        toast.success("Deal terms updated");
        onOpenChange(false);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to update deal",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-blue-500/15 text-blue-600 ring-1 ring-inset ring-blue-500/30 dark:text-blue-400">
              <Pencil className="size-4" />
            </span>
            Edit deal terms
          </DialogTitle>
          <DialogDescription>
            Every time interval is UTC. Saved as deal v{deal.version + 1}.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={handleSubmit} className="space-y-5">
          <DealFormFields
            form={form}
            update={update}
            pending={pending}
            idPrefix="edit_deal"
          />
        </form>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending} className="gap-1.5">
            {pending ? <Spinner size={14} /> : <Pencil className="size-4" />}
            {pending ? "Saving…" : "Save terms"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
