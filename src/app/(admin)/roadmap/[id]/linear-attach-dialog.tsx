"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
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
import { cn } from "@/lib/utils";
import type { LinearIssue, LinearTeam } from "@/lib/linear";
import {
  attachLinearIssue,
  listLinearTeamsAction,
  searchLinearIssuesAction,
} from "../actions";

const ALL_TEAMS = "__all__";

export function LinearAttachDialog({
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
  const [teamKey, setTeamKey] = React.useState<string>(ALL_TEAMS);
  const [term, setTerm] = React.useState("");
  const [results, setResults] = React.useState<LinearIssue[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [attachingId, setAttachingId] = React.useState<string | null>(null);

  // Load teams once when first opened.
  React.useEffect(() => {
    if (!open || teams.length > 0) return;
    let active = true;
    listLinearTeamsAction().then((r) => {
      if (active && r.success) setTeams(r.data);
    });
    return () => {
      active = false;
    };
  }, [open, teams.length]);

  // Reset transient state on close.
  React.useEffect(() => {
    if (!open) {
      setTerm("");
      setResults([]);
      setTeamKey(ALL_TEAMS);
    }
  }, [open]);

  // Debounced search.
  React.useEffect(() => {
    if (!open) return;
    const q = term.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let active = true;
    setSearching(true);
    const handle = setTimeout(async () => {
      const r = await searchLinearIssuesAction(
        q,
        teamKey === ALL_TEAMS ? undefined : teamKey,
      );
      if (!active) return;
      if (r.success) setResults(r.data);
      else toast.error(r.error);
      setSearching(false);
    }, 350);
    return () => {
      active = false;
      clearTimeout(handle);
    };
  }, [term, teamKey, open]);

  async function attach(issue: LinearIssue) {
    setAttachingId(issue.id);
    try {
      const r = await attachLinearIssue({ itemId, issueId: issue.id });
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      toast.success(`Attached ${issue.identifier}`);
      onOpenChange(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to attach issue");
    } finally {
      setAttachingId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Attach a Linear issue</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Select value={teamKey} onValueChange={(v) => v && setTeamKey(v)}>
            <SelectTrigger className="sm:w-40">
              <SelectValue placeholder="All teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TEAMS}>All teams</SelectItem>
              {teams.map((t) => (
                <SelectItem key={t.id} value={t.key}>
                  {t.key} · {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search issues by title or identifier…"
              className="pl-8"
              autoFocus
            />
          </div>
        </div>

        <div className="mt-2 max-h-80 overflow-y-auto rounded-lg border">
          {searching ? (
            <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
              <Spinner size={16} /> Searching…
            </div>
          ) : results.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              {term.trim()
                ? "No matching issues."
                : "Type to search your Linear workspace."}
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {results.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    onClick={() => attach(issue)}
                    disabled={attachingId !== null}
                    className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-accent/50 disabled:opacity-60"
                  >
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {issue.identifier}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {issue.title}
                    </span>
                    {issue.stateName && (
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground",
                        )}
                      >
                        {issue.stateName}
                      </span>
                    )}
                    {attachingId === issue.id && <Spinner size={14} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
