"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { GitBranch, GripVertical, Lightbulb, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { FeatureDialog } from "./feature-dialog";
import { reorderBacklog } from "./actions";
import {
  ROADMAP_STATUS_META,
  type RoadmapColor,
  type RoadmapItemSummary,
} from "./types";

const COLOR_DOT: Record<RoadmapColor, string> = {
  blue: "bg-blue-500",
  emerald: "bg-emerald-500",
  rose: "bg-rose-500",
  cyan: "bg-cyan-500",
  amber: "bg-amber-500",
  purple: "bg-purple-500",
  orange: "bg-orange-500",
  pink: "bg-pink-500",
};

export function RoadmapBacklog({
  items: initialItems,
}: {
  items: RoadmapItemSummary[];
}) {
  const router = useRouter();
  const [items, setItems] = React.useState(initialItems);
  React.useEffect(() => setItems(initialItems), [initialItems]);

  const [dialog, setDialog] = React.useState<
    { mode: "create" } | { mode: "edit"; item: RoadmapItemSummary } | null
  >(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = items.findIndex((i) => i.id === active.id);
    const newIndex = items.findIndex((i) => i.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;

    const next = arrayMove(items, oldIndex, newIndex);
    const prev = items;
    setItems(next);
    try {
      const r = await reorderBacklog({ ids: next.map((i) => i.id) });
      if (!r.success) {
        setItems(prev);
        toast.error(r.error);
        return;
      }
      router.refresh();
    } catch (e) {
      setItems(prev);
      toast.error(e instanceof Error ? e.message : "Failed to reorder backlog");
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex size-7 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
            <Lightbulb className="size-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold leading-tight">Backlog</h2>
            <p className="text-xs text-muted-foreground">
              Unscheduled ideas — drag to reorder, then schedule when ready.
            </p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setDialog({ mode: "create" })}
        >
          <Plus className="size-4" />
          New idea
        </Button>
      </div>

      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        {items.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            No backlog ideas yet. Add one to plan it before placing it on the
            calendar.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={items.map((i) => i.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul>
                {items.map((item) => (
                  <BacklogRow
                    key={item.id}
                    item={item}
                    onOpen={() => router.push(`/roadmap/${item.id}`)}
                    onEdit={() => setDialog({ mode: "edit", item })}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {dialog && (
        <FeatureDialog
          open
          onOpenChange={(v) => {
            if (!v) setDialog(null);
          }}
          mode={dialog.mode}
          item={dialog.mode === "edit" ? dialog.item : null}
        />
      )}
    </section>
  );
}

function BacklogRow({
  item,
  onOpen,
  onEdit,
}: {
  item: RoadmapItemSummary;
  onOpen: () => void;
  onEdit: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const meta = ROADMAP_STATUS_META[item.status];

  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 border-b px-2 py-2 last:border-b-0 hover:bg-accent/30"
    >
      <button
        type="button"
        className="cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="size-4" />
      </button>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          item.color ? COLOR_DOT[item.color] : "bg-muted-foreground/40",
        )}
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left focus-visible:outline-none"
      >
        <span className="block truncate text-sm font-medium">{item.title}</span>
        {item.description && (
          <span className="block truncate text-xs text-muted-foreground">
            {item.description}
          </span>
        )}
      </button>
      {item.linearCount > 0 && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] text-muted-foreground">
          <GitBranch className="size-3" />
          {item.linearCount}
        </span>
      )}
      <span
        className={cn(
          "hidden shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium sm:inline-flex",
          meta.badge,
        )}
      >
        {meta.label}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onEdit}
        aria-label="Edit idea"
      >
        <Pencil className="size-3.5" />
      </Button>
    </li>
  );
}
