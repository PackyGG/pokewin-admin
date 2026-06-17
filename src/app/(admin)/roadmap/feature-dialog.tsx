"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Spinner } from "@/components/ux";
import { cn } from "@/lib/utils";
import {
  archiveRoadmapItem,
  createRoadmapItem,
  updateRoadmapItem,
} from "./actions";
import {
  ROADMAP_COLORS,
  ROADMAP_STATUSES,
  ROADMAP_STATUS_META,
  type RoadmapColor,
  type RoadmapItemSummary,
  type RoadmapStatus,
} from "./types";

// Solid swatch class per accent token — used by the color picker.
const COLOR_SWATCH: Record<RoadmapColor, string> = {
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-500",
  amber: "bg-amber-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  pink: "bg-pink-500",
};

// An ISO timestamp (UTC midnight) → "YYYY-MM-DD" for a date input.
function isoToDateInput(iso: string): string {
  return iso.slice(0, 10);
}

type ItemPayload = {
  title: string;
  description?: string;
  status: RoadmapStatus;
  color?: RoadmapColor;
  startDate?: string;
  endDate?: string;
};

type FeatureDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  /** Required in edit mode — the item being edited. */
  item?: RoadmapItemSummary | null;
  /** Create-mode prefill (e.g. the day an empty cell was clicked). */
  defaultStartDate?: string;
  defaultEndDate?: string;
};

export function FeatureDialog({
  open,
  onOpenChange,
  mode,
  item,
  defaultStartDate,
  defaultEndDate,
}: FeatureDialogProps) {
  const router = useRouter();

  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [status, setStatus] = React.useState<RoadmapStatus>("planned");
  const [scheduled, setScheduled] = React.useState(true);
  const [startDate, setStartDate] = React.useState("");
  const [endDate, setEndDate] = React.useState("");
  const [color, setColor] = React.useState<RoadmapColor | "">("");
  const [saving, setSaving] = React.useState(false);
  const [confirmArchive, setConfirmArchive] = React.useState(false);

  // Reset / hydrate the form whenever the dialog opens.
  React.useEffect(() => {
    if (!open) return;
    const today = new Date().toISOString().slice(0, 10);
    if (mode === "edit" && item) {
      const isScheduled = item.startDate != null && item.endDate != null;
      setTitle(item.title);
      setDescription(item.description ?? "");
      setStatus(item.status);
      setScheduled(isScheduled);
      setStartDate(item.startDate ? isoToDateInput(item.startDate) : today);
      setEndDate(item.endDate ? isoToDateInput(item.endDate) : today);
      setColor(item.color ?? "");
    } else {
      setTitle("");
      setDescription("");
      setStatus("planned");
      setScheduled(!!defaultStartDate);
      setStartDate(defaultStartDate ?? today);
      setEndDate(defaultEndDate ?? defaultStartDate ?? today);
      setColor("");
    }
  }, [open, mode, item, defaultStartDate, defaultEndDate]);

  async function submit() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      toast.error("Title is required");
      return;
    }
    if (scheduled) {
      if (!startDate || !endDate) {
        toast.error("Start and end date are required");
        return;
      }
      if (endDate < startDate) {
        toast.error("End date must be on or after the start date");
        return;
      }
    }

    const payload: ItemPayload = {
      title: trimmedTitle,
      description: description.trim() || undefined,
      status,
      color: color || undefined,
    };
    if (scheduled) {
      payload.startDate = startDate;
      payload.endDate = endDate;
    }

    setSaving(true);
    try {
      if (mode === "edit" && item) {
        const r = await updateRoadmapItem({ id: item.id, ...payload });
        if (!r.success) {
          toast.error(r.error);
          return;
        }
        toast.success("Feature updated");
      } else {
        const r = await createRoadmapItem(payload);
        if (!r.success) {
          toast.error(r.error);
          return;
        }
        toast.success("Feature created");
      }
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save feature");
    } finally {
      setSaving(false);
    }
  }

  async function doArchive() {
    if (!item) return;
    setSaving(true);
    try {
      const r = await archiveRoadmapItem(item.id);
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      toast.success("Feature archived");
      setConfirmArchive(false);
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to archive feature");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog
        open={open && !confirmArchive}
        onOpenChange={(v) => {
          if (!v) onOpenChange(false);
        }}
      >
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {mode === "edit" ? "Edit feature" : "New feature"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="feature-title" className="text-xs font-medium">
                Title
              </Label>
              <Input
                id="feature-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="New deposit flow, seasonal event, …"
                maxLength={200}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="feature-description"
                className="text-xs font-medium"
              >
                Description
                <span className="ml-1 font-normal text-muted-foreground/60">
                  (optional)
                </span>
              </Label>
              <Textarea
                id="feature-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short summary shown on the roadmap."
                rows={3}
                maxLength={2000}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Status</Label>
              <Select
                value={status}
                onValueChange={(v) => v && setStatus(v as RoadmapStatus)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Pick a status" />
                </SelectTrigger>
                <SelectContent>
                  {ROADMAP_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            ROADMAP_STATUS_META[s].dot,
                          )}
                        />
                        {ROADMAP_STATUS_META[s].label}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="space-y-0.5 pr-3">
                <Label
                  htmlFor="feature-scheduled"
                  className="text-xs font-medium"
                >
                  Schedule on calendar
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  Off keeps it in the backlog to plan and order later.
                </p>
              </div>
              <Switch
                id="feature-scheduled"
                checked={scheduled}
                onCheckedChange={(v) => setScheduled(!!v)}
              />
            </div>

            {scheduled && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label
                    htmlFor="feature-start"
                    className="text-xs font-medium"
                  >
                    Start date
                  </Label>
                  <Input
                    id="feature-start"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="feature-end" className="text-xs font-medium">
                    End date
                  </Label>
                  <Input
                    id="feature-end"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">
                Color
                <span className="ml-1 font-normal text-muted-foreground/60">
                  (optional)
                </span>
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                {ROADMAP_COLORS.map((c) => {
                  const selected = color === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setColor(selected ? "" : c)}
                      aria-label={`${c}${selected ? " (selected)" : ""}`}
                      aria-pressed={selected}
                      className={cn(
                        "flex size-7 items-center justify-center rounded-full ring-offset-2 ring-offset-background transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-safe:hover:scale-110",
                        COLOR_SWATCH[c],
                        selected && "ring-2 ring-ring",
                      )}
                    >
                      {selected && (
                        <Check className="size-3.5 text-white" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <DialogFooter className="!items-center !justify-between">
            {mode === "edit" && item ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirmArchive(true)}
                className="text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
                disabled={saving}
              >
                <Trash2 className="size-4" />
                Archive
              </Button>
            ) : (
              <span />
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="button" onClick={submit} disabled={saving}>
                {saving && <Spinner size={14} className="text-current" />}
                {saving
                  ? "Saving…"
                  : mode === "edit"
                    ? "Save changes"
                    : scheduled
                      ? "Create feature"
                      : "Add to backlog"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this feature?</AlertDialogTitle>
            <AlertDialogDescription>
              {item
                ? `"${item.title}" will be removed from the roadmap. This can be undone in the database, but it won't appear on the calendar anymore.`
                : "This cannot be undone from the UI."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={doArchive}
              disabled={saving}
              className="bg-rose-500 text-white hover:bg-rose-500/90"
            >
              {saving && <Spinner size={14} className="text-current" />}
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
