"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  FileText,
  Loader2,
  Library,
  Pencil,
  Save,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { createSet, updateSet } from "./actions";

type SetInitialValues = {
  id: string;
  name: string;
};

type CreateProps = {
  mode: "create";
  trigger?: React.ReactElement;
};

type EditProps = {
  mode: "edit";
  initialValues: SetInitialValues;
  trigger?: React.ReactElement;
};

type SetFormDialogProps = CreateProps | EditProps;

// ────────────────────────────────────────────────────────────────────
//  Section heading — small, inline, sits inside the dialog body.
//  Mirrors the original create-set-button visual rhythm.
// ────────────────────────────────────────────────────────────────────
function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex size-6 items-center justify-center rounded-md bg-primary/10">
          <Icon className="size-3.5 text-primary" />
        </div>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-tight">{title}</h3>
          {description && (
            <p className="text-[11px] text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
      <div className="space-y-3 pl-8">{children}</div>
    </section>
  );
}

export function SetFormDialog(props: SetFormDialogProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const isEdit = props.mode === "edit";
  const initial = isEdit ? props.initialValues : null;

  const [name, setName] = useState(initial?.name ?? "");

  // Reset form when the dialog re-opens so a freshly-rendered Edit dialog
  // doesn't show stale values from a previous open / close cycle.
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
  }, [open, initial]);

  function handleSubmit() {
    startTransition(async () => {
      try {
        if (isEdit) {
          await updateSet(props.initialValues.id, {
            name,
          });
          toast.success("Set updated");
        } else {
          await createSet({
            name,
          });
          toast.success("Set created");
        }
        setOpen(false);
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error
            ? e.message
            : isEdit
              ? "Failed to update set"
              : "Failed to create set",
        );
      }
    });
  }

  // Match the base-ui render-slot pattern from create-set-button: the
  // rendered element is passed bare (no children), and DialogTrigger
  // children become the rendered element's children.
  const defaultTriggerElement = isEdit ? (
    <Button variant="ghost" size="xs" />
  ) : (
    <Button size="sm" />
  );
  const defaultTriggerChildren = isEdit ? (
    <>
      <Pencil className="size-3.5" />
      Edit
    </>
  ) : (
    <>
      <Plus className="size-4" />
      Create Set
    </>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={props.trigger ?? defaultTriggerElement}>
        {props.trigger ? null : defaultTriggerChildren}
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto p-0">
        {/* Flat header band — solid `bg-card` + a hairline rule, matching the
            app-wide flat sweep (no gradient, no corner glows). */}
        <div className="border-b bg-card px-5 py-4">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10">
                <Library className="size-4 text-primary" />
              </div>
              <div>
                <DialogTitle className="text-base font-semibold leading-tight">
                  {isEdit ? "Edit Set" : "Create Set"}
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  {isEdit
                    ? "Update the set name."
                    : "Add a new set to the catalog."}
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        {/* Body — one section. */}
        <div className="space-y-6 px-5 py-5">
          <Section
            icon={FileText}
            title="Set details"
            description="Name of the set."
          >
            <div className="space-y-1.5">
              <Label htmlFor="set-form-name">Name</Label>
              <Input
                id="set-form-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Romance Dawn"
              />
            </div>
          </Section>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isPending || !name}>
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {isEdit ? "Saving..." : "Creating..."}
              </>
            ) : isEdit ? (
              <>
                <Save className="size-4" />
                Save changes
              </>
            ) : (
              <>
                <Plus className="size-4" />
                Create set
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
