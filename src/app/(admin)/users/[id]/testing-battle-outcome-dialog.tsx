"use client";

import { useEffect, useState, useTransition } from "react";
import { FlaskConical } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setTestingBattleOutcomeRuleAction } from "./testing-battle-outcome-actions";

export function TestingBattleOutcomeDialog({
  userId,
  initialRemainingBattles,
}: {
  userId: string;
  initialRemainingBattles: number;
}) {
  const [open, setOpen] = useState(false);
  const [remainingBattles, setRemainingBattles] = useState(
    initialRemainingBattles,
  );
  const [battleCount, setBattleCount] = useState(
    String(initialRemainingBattles),
  );
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setRemainingBattles(initialRemainingBattles);
    setBattleCount(String(initialRemainingBattles));
  }, [initialRemainingBattles]);

  const save = (count: number) => {
    startTransition(async () => {
      const result = await setTestingBattleOutcomeRuleAction({
        userId,
        battleCount: count,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }

      const next = result.data.remaining_battles;
      setRemainingBattles(next);
      setBattleCount(String(next));
      toast.success(
        next === 0
          ? "Battle outcome rule cleared"
          : `Force-loss testing set for ${next} battle${next === 1 ? "" : "s"}`,
      );
      setOpen(false);
    });
  };

  const handleSave = () => {
    const parsed = Number(battleCount);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
      toast.error("Enter a whole number from 0 to 1000");
      return;
    }
    save(parsed);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setBattleCount(String(remainingBattles));
      }}
    >
      <DialogTrigger
        render={
          <Button
            size="sm"
            variant={remainingBattles > 0 ? "destructive" : "outline"}
          />
        }
      >
          <FlaskConical className="size-3.5" />
          Battle test{remainingBattles > 0 ? ` · ${remainingBattles} left` : ""}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Testing battle outcome</DialogTitle>
          <DialogDescription>
            Dev only. For the next configured battles involving this user, the
            backend checks five recent EOS blocks and chooses a losing result
            when available. If all five win, it chooses the lowest-value win.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-2">
          <Label htmlFor={`battle-test-count-${userId}`}>
            Battles remaining
          </Label>
          <Input
            id={`battle-test-count-${userId}`}
            type="number"
            min={0}
            max={1000}
            step={1}
            value={battleCount}
            onChange={(event) => setBattleCount(event.target.value)}
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">
            Set to 0 to clear the rule. One count is consumed when this user
            participates in a battle that reaches outcome execution.
          </p>
        </div>
        <DialogFooter>
          {remainingBattles > 0 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => save(0)}
              disabled={isPending}
            >
              Clear
            </Button>
          )}
          <Button type="button" onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
