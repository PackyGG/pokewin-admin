"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  FileText,
  CalendarDays,
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
  series: string;
  language: string;
  releaseDate: string | null; // ISO string or null
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

/** Trim a possibly-ISO release date down to the YYYY-MM-DD input shape. */
function isoToDateInput(value: string | null): string {
  if (!value) return "";
  // Already short form? Pass through.
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function SetFormDialog(props: SetFormDialogProps) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const isEdit = props.mode === "edit";
  const initial = isEdit ? props.initialValues : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [series, setSeries] = useState(initial?.series ?? "");
  const [language, setLanguage] = useState(initial?.language ?? "en");
  const [releaseDate, setReleaseDate] = useState(
    isoToDateInput(initial?.releaseDate ?? null),
  );

  // Reset form when the dialog re-opens so a freshly-rendered Edit dialog
  // doesn't show stale values from a previous open / close cycle.
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setSeries(initial?.series ?? "");
    setLanguage(initial?.language ?? "en");
    setReleaseDate(isoToDateInput(initial?.releaseDate ?? null));
  }, [open, initial]);

  function handleSubmit() {
    startTransition(async () => {
      try {
        if (isEdit) {
          await updateSet(props.initialValues.id, {
            name,
            series,
            language,
            releaseDate: releaseDate || null,
          });
          toast.success("Set updated");
        } else {
          await createSet({
            name,
            series,
            language,
            releaseDate: releaseDate || null,
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
        {/* Header band — gradient to match the hero aesthetic. */}
        <div className="relative overflow-hidden rounded-t-xl border-b bg-gradient-to-br from-card via-card to-card/60 px-5 py-4">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-blue-500/[0.06] blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -left-16 -bottom-16 size-48 rounded-full bg-purple-500/[0.06] blur-3xl"
          />
          <DialogHeader className="relative">
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
                    ? "Update the name, series, language, or release date."
                    : "Add a new set / series (e.g. One Piece) to the catalog."}
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        {/* Body — two sections. */}
        <div className="space-y-6 px-5 py-5">
          <Section
            icon={FileText}
            title="Set details"
            description="Name, series, and language metadata."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="set-form-name">Name</Label>
                <Input
                  id="set-form-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Romance Dawn"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="set-form-series">Series</Label>
                <Input
                  id="set-form-series"
                  value={series}
                  onChange={(e) => setSeries(e.target.value)}
                  placeholder="e.g. One Piece"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="set-form-language">Language</Label>
                <Input
                  id="set-form-language"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  placeholder="e.g. en"
                />
              </div>
            </div>
          </Section>

          <Section
            icon={CalendarDays}
            title="Release"
            description="Optional release date for the set."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="set-form-release">Release date</Label>
                <Input
                  id="set-form-release"
                  type="date"
                  value={releaseDate}
                  onChange={(e) => setReleaseDate(e.target.value)}
                />
              </div>
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
          <Button
            onClick={handleSubmit}
            disabled={isPending || !name || !series || !language}
          >
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
