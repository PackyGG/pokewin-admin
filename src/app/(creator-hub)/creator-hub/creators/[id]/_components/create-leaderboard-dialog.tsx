"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Trophy, X } from "lucide-react";
import { z } from "zod";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ux";

import {
  createLeaderboard,
  getCreatorCodes,
  searchCreators,
  setLeaderboardSponsorship,
  type CreatorSearchResult,
} from "../../../../../(admin)/creators/leaderboards/actions";

const DEFAULT_TIERS = [
  { position: "1", amount: "" },
  { position: "2", amount: "" },
  { position: "3", amount: "" },
  { position: "4", amount: "" },
  { position: "5", amount: "" },
];

const MIN_DURATION_MS = 6 * 24 * 60 * 60 * 1000;

const leaderboardFormSchema = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(100),
    site_bonus_usd: z.coerce
      .number({ invalid_type_error: "Prize pool must be a number" })
      .positive("Total prize pool must be greater than zero"),
    start_date: z.string().min(1, "Start date is required"),
    end_date: z.string().min(1, "End date is required"),
    affiliate_codes: z.array(z.string()),
    prize_tiers: z
      .array(
        z.object({
          position: z.number().int().positive(),
          prize_amount_usd: z.number().positive(),
        }),
      )
      .min(5, "At least 5 prize tiers are required"),
    sponsored_pct: z.coerce
      .number({ invalid_type_error: "House share % must be a number" })
      .min(0, "House share % must be between 0 and 100")
      .max(100, "House share % must be between 0 and 100"),
  })
  .superRefine((data, ctx) => {
    const startISO = new Date(data.start_date).toISOString();
    const endISO = new Date(data.end_date).toISOString();
    if (Number.isNaN(new Date(startISO).getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid start date",
        path: ["start_date"],
      });
      return;
    }
    if (Number.isNaN(new Date(endISO).getTime())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Enter a valid end date",
        path: ["end_date"],
      });
      return;
    }
    if (new Date(endISO) <= new Date(startISO)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date must be after start date",
        path: ["end_date"],
      });
    }
    if (new Date(endISO) <= new Date()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "End date must be in the future",
        path: ["end_date"],
      });
    }
    const durationMs =
      new Date(endISO).getTime() - new Date(startISO).getTime();
    if (durationMs < MIN_DURATION_MS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Leaderboard must span at least 6 days from start to end",
        path: ["end_date"],
      });
    }

    const tierSum = data.prize_tiers.reduce(
      (acc, t) => acc + t.prize_amount_usd,
      0,
    );
    if (tierSum > data.site_bonus_usd + 1e-6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Tier sum ($${tierSum.toFixed(2)}) exceeds total prize pool ($${data.site_bonus_usd.toFixed(2)})`,
        path: ["prize_tiers"],
      });
    }
  });

type Props = {
  userId: string;
};

/**
 * Creator Hub — "Create Leaderboard" dialog.
 *
 * Hub-native create flow for site-funded affiliate leaderboards on a fixed
 * creator. Reuses `createLeaderboard` / `setLeaderboardSponsorship` from the
 * admin leaderboards module; zod mirrors the server-side create schema.
 */
export function CreateLeaderboardDialog({ userId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [coCreators, setCoCreators] = useState<CreatorSearchResult[]>([]);
  const [coCreatorQuery, setCoCreatorQuery] = useState("");
  const [coCreatorResults, setCoCreatorResults] = useState<CreatorSearchResult[]>([]);
  const [coSearchOpen, setCoSearchOpen] = useState(false);
  const [isCoSearching, setIsCoSearching] = useState(false);
  const coSearchSeqRef = useRef(0);

  const [title, setTitle] = useState("");
  const [codesText, setCodesText] = useState("");
  const [siteBonus, setSiteBonus] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [tiers, setTiers] = useState(DEFAULT_TIERS);
  const [sponsoredPct, setSponsoredPct] = useState("100");

  const totalPool = Number(siteBonus) || 0;
  const tierSum = tiers.reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
  const tierSumExceeds = tierSum > totalPool + 1e-6;

  function reset() {
    setCoCreators([]);
    setCoCreatorQuery("");
    setCoCreatorResults([]);
    setCoSearchOpen(false);
    setTitle("");
    setCodesText("");
    setSiteBonus("");
    setStartDate("");
    setEndDate("");
    setTiers(DEFAULT_TIERS.map((t) => ({ ...t })));
    setSponsoredPct("100");
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const codes = await getCreatorCodes(userId);
        if (cancelled) return;
        setCodesText(codes.join(", "));
      } catch {
        // user can still type codes manually
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, userId]);

  useEffect(() => {
    const trimmed = coCreatorQuery.trim();
    if (trimmed.length < 2) {
      setCoCreatorResults([]);
      setIsCoSearching(false);
      return;
    }

    const seq = ++coSearchSeqRef.current;
    setIsCoSearching(true);
    const handle = setTimeout(async () => {
      try {
        const results = await searchCreators(trimmed);
        if (seq !== coSearchSeqRef.current) return;
        setCoCreatorResults(results);
      } catch {
        if (seq !== coSearchSeqRef.current) return;
        setCoCreatorResults([]);
      } finally {
        if (seq === coSearchSeqRef.current) setIsCoSearching(false);
      }
    }, 200);

    return () => clearTimeout(handle);
  }, [coCreatorQuery]);

  function mergeCodesIntoInput(extra: string[]) {
    if (extra.length === 0) return;
    setCodesText((prev) => {
      const existing = prev
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);
      const seen = new Set(existing.map((c) => c.toUpperCase()));
      const merged = [...existing];
      for (const code of extra) {
        const up = code.toUpperCase();
        if (!seen.has(up)) {
          seen.add(up);
          merged.push(code);
        }
      }
      return merged.join(", ");
    });
  }

  function addCoCreator(c: CreatorSearchResult) {
    if (c.userId === userId) return;
    if (coCreators.some((existing) => existing.userId === c.userId)) return;
    setCoCreators((prev) => [...prev, c]);
    setCoCreatorQuery("");
    setCoCreatorResults([]);
    setCoSearchOpen(false);
    mergeCodesIntoInput(c.codes);
  }

  function removeCoCreator(id: string) {
    setCoCreators((prev) => prev.filter((c) => c.userId !== id));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const codesParsed = codesText
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);

    const tiersParsed = tiers
      .map((t) => ({
        position: Number(t.position),
        prize_amount_usd: Number(t.amount),
      }))
      .filter(
        (t) =>
          Number.isFinite(t.position) &&
          t.position > 0 &&
          Number.isFinite(t.prize_amount_usd) &&
          t.prize_amount_usd > 0,
      )
      .sort((a, b) => a.position - b.position);

    const parsed = leaderboardFormSchema.safeParse({
      title,
      site_bonus_usd: siteBonus,
      start_date: startDate,
      end_date: endDate,
      affiliate_codes: codesParsed,
      prize_tiers: tiersParsed,
      sponsored_pct: sponsoredPct,
    });

    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    const startISO = new Date(parsed.data.start_date).toISOString();
    const endISO = new Date(parsed.data.end_date).toISOString();

    startTransition(async () => {
      const r = await createLeaderboard({
        creator_user_id: userId,
        co_creator_user_ids: coCreators.map((c) => c.userId),
        title: parsed.data.title,
        affiliate_codes: parsed.data.affiliate_codes,
        site_bonus_usd: parsed.data.site_bonus_usd,
        start_date: startISO,
        end_date: endISO,
        prize_tiers: parsed.data.prize_tiers,
      });
      if (!r.success) {
        toast.error(r.error);
        return;
      }

      if (r.data?.id && parsed.data.sponsored_pct !== 100) {
        const sr = await setLeaderboardSponsorship(
          r.data.id,
          parsed.data.sponsored_pct,
        );
        if (!sr.success) {
          toast.error(
            `Leaderboard created, but house share % not saved: ${sr.error}`,
          );
        }
      }

      toast.success("Leaderboard created");
      setOpen(false);
      reset();
      router.refresh();
    });
  }

  function updateTier(idx: number, field: "position" | "amount", value: string) {
    setTiers((prev) =>
      prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)),
    );
  }

  function addTier() {
    const nextPos =
      tiers.length === 0
        ? 1
        : Math.max(...tiers.map((t) => Number(t.position) || 0)) + 1;
    setTiers((prev) => [...prev, { position: String(nextPos), amount: "" }]);
  }

  function removeTier(idx: number) {
    setTiers((prev) => prev.filter((_, i) => i !== idx));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Plus className="mr-1 size-3.5" />
        Create Leaderboard
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 ring-1 ring-inset ring-amber-500/30 dark:text-amber-400">
              <Trophy className="size-4" />
            </span>
            Create affiliate leaderboard
          </DialogTitle>
          <DialogDescription>
            Site-funded leaderboard for this creator. Their balance is not
            touched — the board is created in approved state.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="lb-creator">Creator</Label>
            <Input
              id="lb-creator"
              value={userId}
              disabled
              className="font-mono text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="co_creator_search">
              Co-creators (optional)
            </Label>
            {coCreators.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {coCreators.map((c) => (
                  <div
                    key={c.userId}
                    className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                  >
                    <span className="font-medium">
                      {c.username ?? c.email ?? c.userId.slice(0, 12)}
                    </span>
                    {c.affiliateCode && (
                      <span className="font-mono text-muted-foreground">
                        · {c.affiliateCode}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeCoCreator(c.userId)}
                      className="ml-1 text-muted-foreground hover:text-foreground"
                      aria-label="Remove co-creator"
                      disabled={pending}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="relative">
              <Input
                id="co_creator_search"
                value={coCreatorQuery}
                onChange={(e) => {
                  setCoCreatorQuery(e.target.value);
                  setCoSearchOpen(true);
                }}
                onFocus={() => setCoSearchOpen(true)}
                placeholder="Search to add a co-creator…"
                autoComplete="off"
                disabled={pending}
              />
              {coSearchOpen && coCreatorQuery.trim().length >= 2 && (
                <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
                  {isCoSearching ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      Searching…
                    </div>
                  ) : coCreatorResults.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground">
                      No creators match.
                    </div>
                  ) : (
                    <ul className="max-h-60 overflow-auto py-1">
                      {coCreatorResults
                        .filter(
                          (c) =>
                            c.userId !== userId &&
                            !coCreators.some((x) => x.userId === c.userId),
                        )
                        .map((c) => (
                          <li key={c.userId}>
                            <button
                              type="button"
                              onClick={() => addCoCreator(c)}
                              className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted/60"
                            >
                              <span className="text-sm font-medium">
                                {c.username ?? c.email ?? "(no username)"}
                              </span>
                              <span className="font-mono text-xs text-muted-foreground">
                                {c.affiliateCode
                                  ? `${c.affiliateCode} · ${c.userId.slice(0, 12)}…`
                                  : `${c.userId.slice(0, 12)}…`}
                              </span>
                            </button>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lb-title">Title</Label>
            <Input
              id="lb-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              placeholder="January Race"
              disabled={pending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lb-codes">
              Affiliate codes (comma-separated)
            </Label>
            <Input
              id="lb-codes"
              value={codesText}
              onChange={(e) => setCodesText(e.target.value)}
              placeholder="zog, packy"
              disabled={pending}
            />
            <p className="text-[11px] text-muted-foreground">
              Leave empty to include all of this creator&apos;s codes.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lb-pool">Total prize pool (USD, site-funded)</Label>
            <Input
              id="lb-pool"
              type="number"
              min={0}
              step="0.01"
              value={siteBonus}
              onChange={(e) => setSiteBonus(e.target.value)}
              placeholder="5000"
              disabled={pending}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="lb-start">Start</Label>
              <Input
                id="lb-start"
                type="datetime-local"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                disabled={pending}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lb-end">End</Label>
              <Input
                id="lb-end"
                type="datetime-local"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                disabled={pending}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Prize tiers</Label>
              <span
                className={
                  tierSumExceeds
                    ? "text-xs font-medium text-destructive"
                    : "text-xs text-muted-foreground"
                }
              >
                Sum: ${tierSum.toFixed(2)} / ${totalPool.toFixed(2)}
              </span>
            </div>
            <div className="space-y-2">
              {tiers.map((t, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    placeholder="Pos"
                    value={t.position}
                    onChange={(e) => updateTier(idx, "position", e.target.value)}
                    className="w-16 sm:w-24"
                    disabled={pending}
                  />
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    placeholder="Amount USD"
                    value={t.amount}
                    onChange={(e) => updateTier(idx, "amount", e.target.value)}
                    className="flex-1"
                    disabled={pending}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeTier(idx)}
                    className="shrink-0"
                    disabled={pending}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addTier}
                disabled={pending}
              >
                <Plus className="mr-1 size-4" />
                Add tier
              </Button>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="lb-sponsored">House share % (cost math only)</Label>
            <Input
              id="lb-sponsored"
              type="number"
              min={0}
              max={100}
              step={1}
              value={sponsoredPct}
              onChange={(e) => setSponsoredPct(e.target.value)}
              placeholder="100"
              disabled={pending}
            />
            <p className="text-[11px] text-muted-foreground">
              Portion of the prize pool the house pays on-site. Default 100%.
            </p>
          </div>

          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" disabled={pending} />}
            >
              Cancel
            </DialogClose>
            <Button
              type="submit"
              disabled={pending || tierSumExceeds}
              className="gap-1.5"
            >
              {pending ? <Spinner size={14} /> : <Plus className="size-4" />}
              {pending ? "Creating…" : "Create leaderboard"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
