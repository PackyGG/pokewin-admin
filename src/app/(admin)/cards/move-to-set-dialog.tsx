"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Calendar,
  Check,
  ChevronDown,
  Library,
  Loader2,
  Plus,
  Search,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/utils/format";
import type { SetForMoveDialog } from "@/lib/queries/cards";
import { bulkMoveCardsToSet, createSetForCards } from "./set-actions";

const ADD_NEW_SERIES_SENTINEL = "__ADD_NEW__";

export function MoveToSetDialog({
  open,
  onOpenChange,
  selectedCardIds,
  sets,
  seriesOptions,
  onMoved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedCardIds: string[];
  sets: SetForMoveDialog[];
  seriesOptions: string[];
  onMoved: () => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState("");
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);

  // Create-new-set sub-form
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSeriesSelect, setNewSeriesSelect] = useState<string>(
    seriesOptions[0] ?? ADD_NEW_SERIES_SENTINEL,
  );
  const [newSeriesCustom, setNewSeriesCustom] = useState("");
  const [newLanguage, setNewLanguage] = useState("en");
  const [newReleaseDate, setNewReleaseDate] = useState("");

  const filteredSets = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sets;
    return sets.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.series.toLowerCase().includes(q) ||
        s.language.toLowerCase().includes(q),
    );
  }, [sets, search]);

  function resetState() {
    setSearch("");
    setSelectedSetId(null);
    setCreateOpen(false);
    setNewName("");
    setNewSeriesSelect(seriesOptions[0] ?? ADD_NEW_SERIES_SENTINEL);
    setNewSeriesCustom("");
    setNewLanguage("en");
    setNewReleaseDate("");
  }

  function close(next: boolean) {
    if (!next) resetState();
    onOpenChange(next);
  }

  const effectiveSeries =
    newSeriesSelect === ADD_NEW_SERIES_SENTINEL
      ? newSeriesCustom.trim()
      : newSeriesSelect;

  const createReady =
    createOpen &&
    newName.trim().length > 0 &&
    effectiveSeries.length > 0 &&
    newLanguage.trim().length > 0;

  const selectedSet = sets.find((s) => s.id === selectedSetId) ?? null;

  // The confirm button is enabled when either an existing set is picked
  // OR the create-new form is filled in. In create mode we run the create
  // first, then move using the returned id.
  const canConfirm = (selectedSet !== null || createReady) && !isPending;

  function handleConfirm() {
    if (!canConfirm) return;
    startTransition(async () => {
      try {
        let targetSetId: string;
        let targetSetName: string;

        if (createOpen && createReady) {
          const created = await createSetForCards({
            name: newName,
            series: effectiveSeries,
            language: newLanguage,
            releaseDate: newReleaseDate || null,
          });
          targetSetId = created.id;
          targetSetName = created.name;
        } else if (selectedSet) {
          targetSetId = selectedSet.id;
          targetSetName = selectedSet.name;
        } else {
          return;
        }

        const result = await bulkMoveCardsToSet({
          cardIds: selectedCardIds,
          setId: targetSetId,
        });

        toast.success(
          `Moved ${result.count} card${result.count === 1 ? "" : "s"} to ${targetSetName}`,
        );
        close(false);
        onMoved();
        router.refresh();
      } catch (e) {
        toast.error(
          e instanceof Error ? e.message : "Failed to move cards",
        );
      }
    });
  }

  const targetName =
    createOpen && createReady ? newName.trim() : selectedSet?.name ?? null;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto p-0">
        {/* Header band — matches the rest of the cards page chrome. */}
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
                  Move to set
                </DialogTitle>
                <p className="text-xs text-muted-foreground">
                  Moving{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {selectedCardIds.length}
                  </span>{" "}
                  card{selectedCardIds.length === 1 ? "" : "s"}. Pick an
                  existing set or create a new one.
                </p>
              </div>
            </div>
          </DialogHeader>
        </div>

        {/* Body */}
        <div className="space-y-4 px-5 py-5">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              placeholder="Search sets by name, series, or language..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              autoFocus
            />
          </div>

          {/* Existing sets list */}
          <div className="rounded-xl border bg-card/30 max-h-[260px] overflow-y-auto">
            {filteredSets.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                {sets.length === 0
                  ? "No sets yet — create the first one below."
                  : "No sets match your search."}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {filteredSets.map((s) => {
                  const active = selectedSetId === s.id;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSetId(s.id);
                          // Picking an existing set closes the create-new
                          // section so the operator's intent stays single.
                          setCreateOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-xs motion-safe:transition-colors",
                          active
                            ? "bg-primary/10"
                            : "hover:bg-muted/40",
                        )}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium text-sm">
                              {s.name}
                            </span>
                            <Badge variant="secondary" className="shrink-0">
                              {s.series}
                            </Badge>
                          </div>
                          <div className="mt-0.5 flex items-center gap-3 text-[10px] text-muted-foreground">
                            <span className="uppercase tracking-wide">
                              {s.language}
                            </span>
                            {s.releaseDate && (
                              <span className="flex items-center gap-1">
                                <Calendar className="size-3" />
                                {formatDate(s.releaseDate)}
                              </span>
                            )}
                          </div>
                        </div>
                        {active && (
                          <Check className="size-4 shrink-0 text-primary" />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Create new set — expandable */}
          <div className="rounded-xl border bg-card/30">
            <button
              type="button"
              onClick={() => {
                setCreateOpen((o) => {
                  const next = !o;
                  // Opening the create form clears the existing-set
                  // selection so the two intents don't fight each other.
                  if (next) setSelectedSetId(null);
                  return next;
                });
              }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-xs motion-safe:transition-colors hover:bg-muted/40 rounded-t-xl"
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <div className="flex size-6 items-center justify-center rounded-md bg-primary/10">
                  <Plus className="size-3.5 text-primary" />
                </div>
                Create new set
              </span>
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground motion-safe:transition-transform",
                  createOpen && "rotate-180",
                )}
              />
            </button>
            {createOpen && (
              <div className="space-y-3 border-t px-3 py-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="move-new-set-name">Name</Label>
                    <Input
                      id="move-new-set-name"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. Romance Dawn"
                      maxLength={100}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="move-new-set-series">Series</Label>
                    <Select
                      value={newSeriesSelect}
                      onValueChange={(v) => v && setNewSeriesSelect(v)}
                    >
                      <SelectTrigger
                        id="move-new-set-series"
                        className="w-full"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {seriesOptions.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                        <SelectItem value={ADD_NEW_SERIES_SENTINEL}>
                          <span className="flex items-center gap-1.5">
                            <Sparkles className="size-3.5" />
                            Add new series…
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    {newSeriesSelect === ADD_NEW_SERIES_SENTINEL && (
                      <Input
                        value={newSeriesCustom}
                        onChange={(e) => setNewSeriesCustom(e.target.value)}
                        placeholder="New series name (e.g. One Piece)"
                        maxLength={100}
                        className="mt-2"
                      />
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="move-new-set-language">Language</Label>
                    <Input
                      id="move-new-set-language"
                      value={newLanguage}
                      onChange={(e) => setNewLanguage(e.target.value)}
                      placeholder="en"
                      maxLength={20}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="move-new-set-release">
                      Release date (optional)
                    </Label>
                    <Input
                      id="move-new-set-release"
                      type="date"
                      value={newReleaseDate}
                      onChange={(e) => setNewReleaseDate(e.target.value)}
                    />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  No image is attached — you can add one later from{" "}
                  <span className="font-medium">/sets</span>.
                </p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => close(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!canConfirm}>
            {isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Moving...
              </>
            ) : (
              <>
                <ArrowRight className="size-4" />
                {targetName
                  ? `Move ${selectedCardIds.length} card${selectedCardIds.length === 1 ? "" : "s"} to ${targetName}`
                  : `Move ${selectedCardIds.length} card${selectedCardIds.length === 1 ? "" : "s"}`}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
