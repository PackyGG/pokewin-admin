"use client";

import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

import {
  endLeaderboardNowAction,
  listActiveLeaderboardsAction,
  quickCreateLeaderboardAction,
} from "../actions";

type LeaderboardRow = {
  id: string;
  title: string;
  creator_user_id: string;
  affiliate_codes: string[];
  time_status: "upcoming" | "active" | "ended";
  end_date: string;
  start_date: string;
};

export function LeaderboardsTab() {
  const [creatorId, setCreatorId] = useState("");
  const [codes, setCodes] = useState("");
  const [title, setTitle] = useState("TEST LB");
  const [pool, setPool] = useState("100");
  const [hours, setHours] = useState("24");
  const [list, setList] = useState<LeaderboardRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const refresh = () => {
    startTransition(async () => {
      const res = await listActiveLeaderboardsAction();
      if (!res.success) {
        setError(res.error);
        return;
      }
      setList(res.data ?? []);
    });
  };

  useEffect(() => {
    refresh();
  }, []);

  const create = () => {
    setError(null);
    const codeList = codes
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    if (!creatorId.trim() || codeList.length === 0) {
      setError("creator id and at least one affiliate code are required");
      return;
    }
    startTransition(async () => {
      const res = await quickCreateLeaderboardAction({
        creator_user_id: creatorId.trim(),
        affiliate_codes: codeList,
        title: title.trim() || undefined,
        site_bonus_usd: pool ? Number(pool) : undefined,
        duration_hours: hours ? Number(hours) : undefined,
      });
      if (!res.success) {
        setError(res.error);
        return;
      }
      refresh();
    });
  };

  const endNow = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await endLeaderboardNowAction(id);
      if (!res.success) {
        setError(res.error);
        return;
      }
      refresh();
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Quick-create leaderboard
        </Label>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 max-w-2xl">
          <Input
            placeholder="creator user id"
            value={creatorId}
            onChange={(e) => setCreatorId(e.target.value)}
          />
          <Input
            placeholder="affiliate codes (comma-separated)"
            value={codes}
            onChange={(e) => setCodes(e.target.value)}
          />
          <Input
            placeholder="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={20}
          />
          <Input
            placeholder="prize pool USD"
            type="number"
            value={pool}
            onChange={(e) => setPool(e.target.value)}
          />
          <Input
            placeholder="duration in hours (default 24)"
            type="number"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            className="md:col-span-2"
          />
        </div>
        <Button disabled={pending} onClick={create}>
          {pending ? "Working..." : "Create"}
        </Button>
        <p className="text-xs text-muted-foreground">
          Auto-fills 10 prize tiers and aligns start to the next top-of-hour UTC.
          The leaderboard is approved on insert (site-funded), so it&apos;s live as
          soon as start_date hits.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Active &amp; upcoming
          </Label>
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={refresh}
          >
            Refresh
          </Button>
        </div>
        {list.length === 0 && (
          <p className="text-sm text-muted-foreground">No active leaderboards.</p>
        )}
        {list.length > 0 && (
          <div className="rounded-md border divide-y">
            {list.map((lb) => (
              <div key={lb.id} className="flex items-start justify-between gap-3 p-3">
                <div className="text-sm space-y-0.5">
                  <div className="font-medium flex items-center gap-2">
                    {lb.title}
                    <Badge variant="outline">{lb.time_status}</Badge>
                  </div>
                  <div className="text-xs text-muted-foreground font-mono">
                    {lb.id}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    creator {lb.creator_user_id}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    codes: {lb.affiliate_codes.join(", ") || "(none)"}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    ends {new Date(lb.end_date).toLocaleString()}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => endNow(lb.id)}
                >
                  End now
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
