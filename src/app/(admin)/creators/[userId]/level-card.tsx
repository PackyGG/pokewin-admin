"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Pencil, Check, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AFFILIATE_LEVEL_COLORS, AFFILIATE_LEVEL_LABELS } from "@/lib/constants";
import { updateAffiliateLevel } from "../actions";

const LEVELS = [1, 2, 3, 4, 5, 6, 7, 8];

export function LevelCard({
  userId,
  currentLevel,
}: {
  userId: string;
  currentLevel: number;
}) {
  const [editing, setEditing] = useState(false);
  const [level, setLevel] = useState(String(currentLevel));
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    const val = parseInt(level, 10);
    if (isNaN(val) || val < 1 || val > 8) {
      toast.error("Invalid level");
      return;
    }
    startTransition(async () => {
      try {
        await updateAffiliateLevel(userId, val);
        toast.success("Level updated");
        setEditing(false);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to update level");
      }
    });
  }

  function handleCancel() {
    setLevel(String(currentLevel));
    setEditing(false);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm font-medium">Affiliate Level</CardTitle>
        {!editing && (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="mr-1 size-3.5" />
            Edit
          </Button>
        )}
        {editing && (
          <div className="flex gap-1">
            <Button size="icon" variant="ghost" className="size-7" onClick={handleSave} disabled={isPending}>
              <Check className="size-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="size-7" onClick={handleCancel} disabled={isPending}>
              <X className="size-3.5" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <Select value={level} onValueChange={(v) => v && setLevel(v)}>
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVELS.map((l) => (
                <SelectItem key={l} value={String(l)}>
                  Level {l} — {AFFILIATE_LEVEL_LABELS[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant="outline" className={AFFILIATE_LEVEL_COLORS[currentLevel] ?? ""}>
            Level {currentLevel} — {AFFILIATE_LEVEL_LABELS[currentLevel] ?? `Level ${currentLevel}`}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
