"use client";

import { useEffect, useRef, useState } from "react";
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
import { GripVertical, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils/format";

const CARD_COLORS = [
  { value: "", label: "None" },
  { value: "white", label: "White" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "purple", label: "Purple" },
  { value: "red", label: "Red" },
  { value: "gold", label: "Gold" },
  { value: "rainbow", label: "Rainbow" },
] as const;

export type SortableCard = {
  cardId: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number;
  odds: number;
  color: string | null;
  animation: boolean;
};

function OddsInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const focusedRef = useRef(false);

  // Parent can bulk-update odds (e.g. target-EV Set); sync display when not editing.
  useEffect(() => {
    if (!focusedRef.current) {
      setText(String(value));
    }
  }, [value]);

  return (
    <Input
      type="text"
      inputMode="decimal"
      placeholder="0.0001 – 100"
      value={text}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "" || /^\d*\.?\d{0,4}$/.test(raw)) {
          setText(raw);
          const n = parseFloat(raw);
          if (!isNaN(n)) onChange(Math.min(100, Math.max(0, n)));
          else if (raw === "") onChange(0);
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        const clamped = Math.min(100, Math.max(0.0001, value));
        onChange(clamped);
        setText(String(clamped));
      }}
      className="h-7 text-xs"
    />
  );
}

function ColorSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
      <SelectTrigger size="sm" className="h-7 w-full text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {CARD_COLORS.map((c) => (
          <SelectItem key={c.value} value={c.value}>
            {c.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SortableCardRow({
  card,
  index,
  updateCard,
  removeCard,
}: {
  card: SortableCard;
  index: number;
  updateCard: (index: number, updates: Partial<SortableCard>) => void;
  removeCard: (index: number) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.cardId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <tr ref={setNodeRef} style={style} className="border-b last:border-0">
      <td className="pl-2 pr-0 py-2 w-6">
        <button
          type="button"
          className="cursor-grab touch-none text-muted-foreground hover:text-foreground"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="size-3.5" />
        </button>
      </td>
      <td className="p-2">
        <div className="flex items-center gap-2">
          {card.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={card.imageUrl} alt="" className="size-8 rounded object-contain" />
          )}
          <div className="min-w-0">
            <div className="truncate text-sm">{card.name}</div>
          </div>
        </div>
      </td>
      <td className="p-2 text-right text-xs text-muted-foreground">
        {formatCurrency(card.priceUsd)}
      </td>
      <td className="p-2">
        <OddsInput
          value={card.odds}
          onChange={(odds) => updateCard(index, { odds })}
        />
      </td>
      <td className="p-2">
        <ColorSelect
          value={card.color ?? ""}
          onChange={(color) => updateCard(index, { color: color || null })}
        />
      </td>
      <td className="p-2">
        <Switch
          size="sm"
          checked={card.animation}
          onCheckedChange={(checked) => updateCard(index, { animation: !!checked })}
        />
      </td>
      <td className="p-2">
        <Button variant="ghost" size="icon-sm" onClick={() => removeCard(index)}>
          <Trash2 className="size-3.5 text-destructive" />
        </Button>
      </td>
    </tr>
  );
}

export function SortableCardTable({
  cards,
  onReorder,
  updateCard,
  removeCard,
}: {
  cards: SortableCard[];
  onReorder: (cards: SortableCard[]) => void;
  updateCard: (index: number, updates: Partial<SortableCard>) => void;
  removeCard: (index: number) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = cards.findIndex((c) => c.cardId === active.id);
      const newIndex = cards.findIndex((c) => c.cardId === over.id);
      onReorder(arrayMove(cards, oldIndex, newIndex));
    }
  }

  return (
    <div className="max-h-[300px] overflow-y-auto rounded-md border">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragEnd={handleDragEnd}
      >
        <table className="w-full table-fixed text-sm">
          <thead className="sticky top-0 bg-background border-b">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="pl-2 pr-0 py-2 w-6" />
              <th className="p-2">Card</th>
              <th className="p-2 w-20 text-right">Price</th>
              <th className="p-2 w-28">Odds %</th>
              <th className="p-2 w-24">Color</th>
              <th className="p-2 w-20">Anim.</th>
              <th className="p-2 w-10" />
            </tr>
          </thead>
          <SortableContext
            items={cards.map((c) => c.cardId)}
            strategy={verticalListSortingStrategy}
          >
            <tbody>
              {cards.map((card, i) => (
                <SortableCardRow
                  key={card.cardId}
                  card={card}
                  index={i}
                  updateCard={updateCard}
                  removeCard={removeCard}
                />
              ))}
            </tbody>
          </SortableContext>
        </table>
      </DndContext>
    </div>
  );
}
