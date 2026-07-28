"use client";

import { useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { HandCoins, Plus } from "lucide-react";

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
import { Spinner } from "@/components/ux";

import { createCreatorDeal } from "../../../../../(admin)/creators/backend-actions";
import {
  buildCreateDefaults,
  dealFormSchema,
  DealFormFields,
  toDealPayload,
  type DealFormState,
} from "./deal-form-shared";

type Props = {
  userId: string;
};

/**
 * Creator Hub — "New Deal" dialog.
 *
 * Hub-native create flow for weekly fill deals. Reuses the existing
 * `createCreatorDeal` server action from the admin creators module; the
 * schema + field grid live in `deal-form-shared.tsx` (shared with Edit).
 */
export function NewDealDialog({ userId }: Props) {
  const formId = useId();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const initial = useMemo(() => buildCreateDefaults(), []);
  const [form, setForm] = useState<DealFormState>(initial);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (next) setForm(buildCreateDefaults());
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

    startTransition(async () => {
      try {
        await createCreatorDeal(userId, payload);
        toast.success("Deal created");
        setOpen(false);
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to create deal",
        );
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus className="mr-1 size-3.5" />
        New Deal
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-400">
              <HandCoins className="size-4" />
            </span>
            New weekly deal
          </DialogTitle>
          <DialogDescription>
            Every time interval is UTC. Week windows cannot overlap another
            non-terminated deal for this creator.
          </DialogDescription>
        </DialogHeader>

        <form id={formId} onSubmit={handleSubmit} className="space-y-5">
          <DealFormFields
            form={form}
            update={update}
            pending={pending}
            idPrefix="new_deal"
          />
        </form>

        <DialogFooter>
          <DialogClose
            render={<Button variant="outline" disabled={pending} />}
          >
            Cancel
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending} className="gap-1.5">
            {pending ? <Spinner size={14} /> : <Plus className="size-4" />}
            {pending ? "Creating…" : "Create deal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
