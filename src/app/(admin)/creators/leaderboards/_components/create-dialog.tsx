"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, X } from "lucide-react";

import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

import {
    createLeaderboard,
    getCreatorCodes,
    searchCreators,
    type CreatorSearchResult,
} from "../actions";

type Props = {
    trigger: React.ReactElement;
    fixedCreatorUserId?: string;
};

export function CreateDialog({ trigger, fixedCreatorUserId }: Props) {
    const [open, setOpen] = useState(false);
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    const [creatorUserId, setCreatorUserId] = useState(fixedCreatorUserId ?? "");
    const [selectedCreator, setSelectedCreator] = useState<CreatorSearchResult | null>(null);
    const [creatorQuery, setCreatorQuery] = useState("");
    const [creatorResults, setCreatorResults] = useState<CreatorSearchResult[]>([]);
    const [searchOpen, setSearchOpen] = useState(false);
    const [isSearching, setIsSearching] = useState(false);
    const searchSeqRef = useRef(0);

    // Multi-creator support: co-creators are additional creators whose codes
    // also count toward this leaderboard. The primary creator above remains
    // the owner/funder; co-creators are aggregation-only.
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
    const [tiers, setTiers] = useState<Array<{ position: string; amount: string }>>([
        { position: "1", amount: "" },
    ]);

    const totalPool = Number(siteBonus) || 0;
    const tierSum = tiers.reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
    const tierSumExceeds = tierSum > totalPool + 1e-6;

    const reset = () => {
        setCreatorUserId(fixedCreatorUserId ?? "");
        setSelectedCreator(null);
        setCreatorQuery("");
        setCreatorResults([]);
        setSearchOpen(false);
        setCoCreators([]);
        setCoCreatorQuery("");
        setCoCreatorResults([]);
        setCoSearchOpen(false);
        setTitle("");
        setCodesText("");
        setSiteBonus("");
        setStartDate("");
        setEndDate("");
        setTiers([{ position: "1", amount: "" }]);
    };

    // Merge a list of codes into the comma-separated codes input, preserving
    // the user's existing entries and skipping duplicates (case-insensitive).
    const mergeCodesIntoInput = (extra: string[]) => {
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
    };

    useEffect(() => {
        if (fixedCreatorUserId) return;
        const trimmed = creatorQuery.trim();
        if (trimmed.length < 2) {
            setCreatorResults([]);
            setIsSearching(false);
            return;
        }

        const seq = ++searchSeqRef.current;
        setIsSearching(true);
        const handle = setTimeout(async () => {
            try {
                const results = await searchCreators(trimmed);
                if (seq !== searchSeqRef.current) return;
                setCreatorResults(results);
            } catch {
                if (seq !== searchSeqRef.current) return;
                setCreatorResults([]);
            } finally {
                if (seq === searchSeqRef.current) setIsSearching(false);
            }
        }, 200);

        return () => clearTimeout(handle);
    }, [creatorQuery, fixedCreatorUserId]);

    // Co-creator search runs the same debounced query independently of the
    // primary picker so admins can add multiple co-creators in one session.
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

    const pickCreator = (c: CreatorSearchResult) => {
        setSelectedCreator(c);
        setCreatorUserId(c.userId);
        setCreatorQuery("");
        setSearchOpen(false);
        setCodesText(c.codes.join(", "));
    };

    const clearCreator = () => {
        setSelectedCreator(null);
        setCreatorUserId("");
        setCreatorQuery("");
        setCodesText("");
    };

    const addCoCreator = (c: CreatorSearchResult) => {
        // Don't add the primary creator as a co-creator, and don't add the
        // same co-creator twice. Either case would be flagged by the backend
        // but rejecting it client-side is faster feedback.
        if (c.userId === creatorUserId) return;
        if (coCreators.some((existing) => existing.userId === c.userId)) return;
        setCoCreators((prev) => [...prev, c]);
        setCoCreatorQuery("");
        setCoCreatorResults([]);
        setCoSearchOpen(false);
        mergeCodesIntoInput(c.codes);
    };

    const removeCoCreator = (userId: string) => {
        setCoCreators((prev) => prev.filter((c) => c.userId !== userId));
    };

    // Auto-fill codes when the dialog is opened on a fixed creator (e.g. from
    // the creator detail page) — the search picker isn't used in that path so
    // we fetch the codes directly.
    useEffect(() => {
        if (!open || !fixedCreatorUserId) return;
        let cancelled = false;
        (async () => {
            try {
                const codes = await getCreatorCodes(fixedCreatorUserId);
                if (cancelled) return;
                setCodesText(codes.join(", "));
            } catch {
                // ignore — user can still type codes manually
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [open, fixedCreatorUserId]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        if (!fixedCreatorUserId && creatorUserId.trim().length === 0) {
            toast.error("Creator user id is required");
            return;
        }
        if (title.trim().length === 0) {
            toast.error("Title is required");
            return;
        }
        if (totalPool <= 0) {
            toast.error("Total prize pool must be greater than zero");
            return;
        }
        if (!startDate || !endDate) {
            toast.error("Start and end dates are required");
            return;
        }

        const startISO = new Date(startDate).toISOString();
        const endISO = new Date(endDate).toISOString();
        if (new Date(endISO) <= new Date(startISO)) {
            toast.error("End date must be after start date");
            return;
        }

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

        if (tiersParsed.length === 0) {
            toast.error("At least one prize tier is required");
            return;
        }
        if (tierSumExceeds) {
            toast.error(
                `Tier sum ($${tierSum.toFixed(2)}) exceeds total prize pool ($${totalPool.toFixed(2)})`,
            );
            return;
        }

        startTransition(async () => {
            const r = await createLeaderboard({
                creator_user_id: creatorUserId.trim(),
                co_creator_user_ids: coCreators.map((c) => c.userId),
                title: title.trim(),
                affiliate_codes: codesParsed,
                site_bonus_usd: totalPool,
                start_date: startISO,
                end_date: endISO,
                prize_tiers: tiersParsed,
            });
            if (!r.success) {
                toast.error(r.error);
                return;
            }
            toast.success("Leaderboard created");
            setOpen(false);
            reset();
            router.refresh();
        });
    };

    const updateTier = (idx: number, field: "position" | "amount", value: string) => {
        setTiers((prev) =>
            prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)),
        );
    };

    const addTier = () => {
        const nextPos =
            tiers.length === 0
                ? 1
                : Math.max(...tiers.map((t) => Number(t.position) || 0)) + 1;
        setTiers((prev) => [...prev, { position: String(nextPos), amount: "" }]);
    };

    const removeTier = (idx: number) => {
        setTiers((prev) => prev.filter((_, i) => i !== idx));
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (!next) reset();
            }}
        >
            <DialogTrigger render={trigger} />
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Create a creator leaderboard</DialogTitle>
                    <DialogDescription>
                        Site-funded leaderboard for a creator. The creator&apos;s balance is not touched.
                        The leaderboard is created in approved state.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="creator_search">Creator</Label>
                        {fixedCreatorUserId ? (
                            <Input
                                id="creator_search"
                                value={creatorUserId}
                                disabled
                            />
                        ) : selectedCreator ? (
                            <div className="flex items-center justify-between rounded-md border px-3 py-2">
                                <div className="flex flex-col">
                                    <span className="text-sm font-medium">
                                        {selectedCreator.username ?? selectedCreator.email ?? "(no username)"}
                                    </span>
                                    <span className="text-xs text-muted-foreground font-mono">
                                        {selectedCreator.affiliateCode
                                            ? `${selectedCreator.affiliateCode} · ${selectedCreator.userId.slice(0, 12)}…`
                                            : `${selectedCreator.userId.slice(0, 12)}…`}
                                    </span>
                                </div>
                                <Button type="button" variant="ghost" size="icon" onClick={clearCreator}>
                                    <X className="size-4" />
                                </Button>
                            </div>
                        ) : (
                            <div className="relative">
                                <Input
                                    id="creator_search"
                                    value={creatorQuery}
                                    onChange={(e) => {
                                        setCreatorQuery(e.target.value);
                                        setSearchOpen(true);
                                    }}
                                    onFocus={() => setSearchOpen(true)}
                                    placeholder="Search creators by username, email, or code..."
                                    autoComplete="off"
                                />
                                {searchOpen && creatorQuery.trim().length >= 2 && (
                                    <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
                                        {isSearching ? (
                                            <div className="px-3 py-2 text-sm text-muted-foreground">
                                                Searching…
                                            </div>
                                        ) : creatorResults.length === 0 ? (
                                            <div className="px-3 py-2 text-sm text-muted-foreground">
                                                No creators match.
                                            </div>
                                        ) : (
                                            <ul className="max-h-60 overflow-auto py-1">
                                                {creatorResults.map((c) => (
                                                    <li key={c.userId}>
                                                        <button
                                                            type="button"
                                                            onClick={() => pickCreator(c)}
                                                            className="flex w-full flex-col items-start px-3 py-2 text-left hover:bg-muted/60"
                                                        >
                                                            <span className="text-sm font-medium">
                                                                {c.username ?? c.email ?? "(no username)"}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground font-mono">
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
                        )}
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="co_creator_search">
                            Co-creators (optional) — their codes also count toward this leaderboard
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
                                            <span className="text-muted-foreground font-mono">
                                                · {c.affiliateCode}
                                            </span>
                                        )}
                                        <button
                                            type="button"
                                            onClick={() => removeCoCreator(c.userId)}
                                            className="ml-1 text-muted-foreground hover:text-foreground"
                                            aria-label="Remove co-creator"
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
                                placeholder="Search to add a co-creator..."
                                autoComplete="off"
                                disabled={!creatorUserId.trim()}
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
                                                        c.userId !== creatorUserId &&
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
                                                            <span className="text-xs text-muted-foreground font-mono">
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

                    <div className="space-y-2">
                        <Label htmlFor="title">Title</Label>
                        <Input
                            id="title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={100}
                            placeholder="January Race"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="codes">
                            Affiliate codes (comma-separated, leave empty for all of the creator&apos;s codes)
                        </Label>
                        <Input
                            id="codes"
                            value={codesText}
                            onChange={(e) => setCodesText(e.target.value)}
                            placeholder="zog, packy"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="site_bonus">Total prize pool (USD, site-funded)</Label>
                        <Input
                            id="site_bonus"
                            type="number"
                            min={0}
                            step="0.01"
                            value={siteBonus}
                            onChange={(e) => setSiteBonus(e.target.value)}
                            placeholder="5000"
                        />
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="start_date">Start</Label>
                            <Input
                                id="start_date"
                                type="datetime-local"
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="end_date">End</Label>
                            <Input
                                id="end_date"
                                type="datetime-local"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between">
                            <Label>Prize tiers</Label>
                            <span
                                className={
                                    tierSumExceeds
                                        ? "text-xs text-destructive font-medium"
                                        : "text-xs text-muted-foreground"
                                }
                            >
                                Sum: ${tierSum.toFixed(2)} / ${totalPool.toFixed(2)}
                            </span>
                        </div>
                        <div className="space-y-2">
                            {tiers.map((t, idx) => (
                                <div key={idx} className="flex gap-2 items-center">
                                    <Input
                                        type="number"
                                        min={1}
                                        step={1}
                                        placeholder="Pos"
                                        value={t.position}
                                        onChange={(e) => updateTier(idx, "position", e.target.value)}
                                        className="w-16 sm:w-24"
                                    />
                                    <Input
                                        type="number"
                                        min={0}
                                        step="0.01"
                                        placeholder="Amount USD"
                                        value={t.amount}
                                        onChange={(e) => updateTier(idx, "amount", e.target.value)}
                                        className="flex-1"
                                    />
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => removeTier(idx)}
                                        className="shrink-0"
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            ))}
                            <Button type="button" variant="outline" size="sm" onClick={addTier}>
                                <Plus className="size-4 mr-1" /> Add tier
                            </Button>
                        </div>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => setOpen(false)}
                            disabled={isPending}
                            className="w-full sm:w-auto"
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={isPending || tierSumExceeds}
                            className="w-full sm:w-auto"
                        >
                            {isPending ? "Creating..." : "Create"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
