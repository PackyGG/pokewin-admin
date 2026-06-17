"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { Spinner } from "@/components/ux";
import type { LinearTeam } from "@/lib/linear";
import { createLinearIssueAction, listLinearTeamsAction } from "../actions";

export function LinearCreateDialog({
  itemId,
  open,
  onOpenChange,
}: {
  itemId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [teams, setTeams] = React.useState<LinearTeam[]>([]);
  const [teamId, setTeamId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    listLinearTeamsAction().then((r) => {
      if (active && r.success) setTeams(r.data);
    });
    return () => {
      active = false;
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      setTeamId("");
      setTitle("");
      setDescription("");
    }
  }, [open]);

  async function submit() {
    if (!teamId) {
      toast.error("Pick a team");
      return;
    }
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error("Title is required");
      return;
    }
    setSaving(true);
    try {
      const r = await createLinearIssueAction({
        itemId,
        teamId,
        title: trimmed,
        description: description.trim() || undefined,
      });
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      toast.success("Linear task created");
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create task");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Linear task</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Team</Label>
            <Select value={teamId} onValueChange={(v) => v && setTeamId(v)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Pick a team" />
              </SelectTrigger>
              <SelectContent>
                {teams.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.key} · {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="linear-title" className="text-xs font-medium">
              Title
            </Label>
            <Input
              id="linear-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Issue title"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="linear-desc" className="text-xs font-medium">
              Description
              <span className="ml-1 font-normal text-muted-foreground/60">
                (optional)
              </span>
            </Label>
            <Textarea
              id="linear-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Context for the task (markdown supported in Linear)."
              rows={4}
              maxLength={4000}
            />
          </div>
        </div>

        <DialogFooter>
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
            {saving ? "Creating…" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
