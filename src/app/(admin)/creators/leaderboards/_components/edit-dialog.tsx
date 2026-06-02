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
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

import {
    editLeaderboard,
    searchCreators,
    setLeaderboardSponsorship,
    type CreatorSearchResult,
} from "../actions";

type Tier = { position: number; prize_amount_usd: string };

type Leaderboard = {
    id: string;
    title: string;
    creator_user_id: string;
    co_creator_user_ids: string[];
    affiliate_codes: string[];
    creator_prize_usd: string;
    site_bonus_usd: string;
    start_date: string;
    end_date: string;
    prize_tiers: Tier[];
};

// Lightweight display row built from the existing co_creator_user_ids array.
// We don't have usernames/emails at mount time; the edit dialog hydrates them
// lazily via searchCreators when admin opens the add picker. Until then we
// just show the truncated user id so the chip is still removable.
type CoCreatorChip = {
    userId: string;
    username: string | null;
    email: string | null;
    affiliateCode: string | null;
};

type Props = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    leaderboard: Leaderboard;
    // Admin-side sponsored % (cost-math input); null = not annotated
    // yet, in which case the field starts at the 100% default.
    currentSponsoredPct: number | null;
};

function toLocalDateTimeInput(iso: string): string {
    // <input type="datetime-local"> wants `YYYY-MM-DDTHH:mm` in local time.
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Affiliate leaderboards must align to whole-hour UTC marks (backend rule).
 * For whole-hour-offset timezones — which we support — that's equivalent to
 * checking the local date for minutes/seconds/ms === 0. Half-hour zones (Iran,
 * India) would fail this *and* the backend's UTC check, which is by design.
 */
function isTopOfHour(date: Date): boolean {
    return (
        date.getMinutes() === 0 &&
        date.getSeconds() === 0 &&
        date.getMilliseconds() === 0
    );
}

export function EditDialog({
    open,
    onOpenChange,
    leaderboard,
    currentSponsoredPct,
}: Props) {
    const [title, setTitle] = useState(leaderboard.title);
    const [codesText, setCodesText] = useState(leaderboard.affiliate_codes.join(", "));
    const [startDate, setStartDate] = useState(toLocalDateTimeInput(leaderboard.start_date));
    const [endDate, setEndDate] = useState(toLocalDateTimeInput(leaderboard.end_date));
    const [tiers, setTiers] = useState<Array<{ position: string; amount: string }>>(
        leaderboard.prize_tiers.map((t) => ({
            position: String(t.position),
            amount: t.prize_amount_usd,
        })),
    );
    // Editable site-funded portion of the total prize pool. Lets the
    // admin lower the pool when they want to shrink the leaderboard;
    // previously this was create-only and a leaderboard couldn't be
    // lowered after creation. Validation below stops a save that would
    // push the tier sum above the new pool.
    const [siteBonus, setSiteBonus] = useState(leaderboard.site_bonus_usd);
    // House share % — cost-math annotation (the house's share of the
    // prize pool). Starts at the saved value or the 100% default.
    const [sponsoredPct, setSponsoredPct] = useState(
        String(currentSponsoredPct ?? 100),
    );

    // Co-creators editing: seed from the row's existing array, then let the
    // admin add/remove via the same search picker used in create-dialog.
    const [coCreators, setCoCreators] = useState<CoCreatorChip[]>(
        leaderboard.co_creator_user_ids.map((id) => ({
            userId: id,
            username: null,
            email: null,
            affiliateCode: null,
        })),
    );
    const [coCreatorQuery, setCoCreatorQuery] = useState("");
    const [coCreatorResults, setCoCreatorResults] = useState<CreatorSearchResult[]>([]);
    const [coSearchOpen, setCoSearchOpen] = useState(false);
    const [isCoSearching, setIsCoSearching] = useState(false);
    const coSearchSeqRef = useRef(0);
    const [isPending, startTransition] = useTransition();
    const router = useRouter();

    // Total pool = creator-funded (locked, set at deal time) + the
    // site-funded portion the admin is editing now. The validation
    // recomputes live as either the tiers or the site bonus changes
    // so the admin sees the new ratio immediately.
    const siteBonusNum = Number(siteBonus) || 0;
    const totalPool = Number(leaderboard.creator_prize_usd) + siteBonusNum;
    const originalPool = Number(leaderboard.creator_prize_usd) + Number(leaderboard.site_bonus_usd);

    const tierSum = tiers.reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
    const sumDelta = tierSum - totalPool;
    // Backend rule: tier sum MUST equal total pool exactly (not just
    // ≤). Mirror that here so the save button stays disabled until
    // the two match — `1e-6` tolerance for floating-point rounding
    // when the admin types e.g. "1500.00".
    const tierSumMismatch = Math.abs(sumDelta) > 1e-6;
    const tierSumExceeds = sumDelta > 1e-6;
    const siteBonusInvalid = !Number.isFinite(siteBonusNum) || siteBonusNum < 0;

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

    const addCoCreator = (c: CreatorSearchResult) => {
        if (c.userId === leaderboard.creator_user_id) return;
        if (coCreators.some((existing) => existing.userId === c.userId)) return;
        setCoCreators((prev) => [
            ...prev,
            {
                userId: c.userId,
                username: c.username,
                email: c.email,
                affiliateCode: c.affiliateCode,
            },
        ]);
        setCoCreatorQuery("");
        setCoCreatorResults([]);
        setCoSearchOpen(false);

        // Merge this creator's codes into the codes input (dedup case-insensitive)
        // so admins don't have to copy them by hand.
        if (c.codes.length > 0) {
            setCodesText((prev) => {
                const existing = prev
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0);
                const seen = new Set(existing.map((s) => s.toUpperCase()));
                const merged = [...existing];
                for (const code of c.codes) {
                    if (!seen.has(code.toUpperCase())) {
                        seen.add(code.toUpperCase());
                        merged.push(code);
                    }
                }
                return merged.join(", ");
            });
        }
    };

    const removeCoCreator = (userId: string) => {
        setCoCreators((prev) => prev.filter((c) => c.userId !== userId));
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();

        const titleChanged = title.trim() !== leaderboard.title;
        const codesParsed = codesText
            .split(",")
            .map((c) => c.trim())
            .filter((c) => c.length > 0);
        const codesChanged =
            JSON.stringify(codesParsed) !== JSON.stringify(leaderboard.affiliate_codes);

        const startParsed = startDate ? new Date(startDate) : null;
        const endParsed = endDate ? new Date(endDate) : null;

        if (startParsed && !isTopOfHour(startParsed)) {
            toast.error("Start must be a whole hour (e.g. 17:00, 18:00)");
            return;
        }
        if (endParsed && !isTopOfHour(endParsed)) {
            toast.error("End must be a whole hour (e.g. 17:00, 18:00)");
            return;
        }

        const startISO = startParsed ? startParsed.toISOString() : undefined;
        const endISO = endParsed ? endParsed.toISOString() : undefined;
        const startChanged = startISO && startISO !== new Date(leaderboard.start_date).toISOString();
        const endChanged = endISO && endISO !== new Date(leaderboard.end_date).toISOString();

        const tiersParsed = tiers
            .map((t) => ({
                position: Number(t.position),
                prize_amount_usd: Number(t.amount),
            }))
            .filter((t) => Number.isFinite(t.position) && t.position > 0 && Number.isFinite(t.prize_amount_usd) && t.prize_amount_usd > 0);

        const originalTiers = leaderboard.prize_tiers
            .map((t) => ({ position: t.position, prize_amount_usd: Number(t.prize_amount_usd) }))
            .sort((a, b) => a.position - b.position);
        const newTiersSorted = [...tiersParsed].sort((a, b) => a.position - b.position);
        const tiersChanged = JSON.stringify(originalTiers) !== JSON.stringify(newTiersSorted);

        const coCreatorIds = coCreators.map((c) => c.userId);
        const coCreatorsChanged =
            JSON.stringify([...coCreatorIds].sort())
                !== JSON.stringify([...leaderboard.co_creator_user_ids].sort());

        const payload: {
            title?: string;
            affiliate_codes?: string[];
            co_creator_user_ids?: string[];
            start_date?: string;
            end_date?: string;
            prize_tiers?: Array<{ position: number; prize_amount_usd: number }>;
            site_bonus_usd?: number;
        } = {};

        if (titleChanged) payload.title = title.trim();
        if (codesChanged) payload.affiliate_codes = codesParsed;
        if (coCreatorsChanged) payload.co_creator_user_ids = coCreatorIds;
        if (startChanged) payload.start_date = startISO;
        if (endChanged) payload.end_date = endISO;

        // Site-funded pool — only included when the admin actually changed
        // it. The tier-sum guard below uses the NEW pool when present so
        // an admin can lower the pool + the tier amounts in a single
        // save without the validation flagging the intermediate state.
        const siteBonusChanged =
            Math.abs(siteBonusNum - Number(leaderboard.site_bonus_usd)) > 1e-6;
        if (siteBonusChanged) {
            if (siteBonusInvalid) {
                toast.error("Site-funded pool must be 0 or greater");
                return;
            }
            payload.site_bonus_usd = siteBonusNum;
        }

        // Strict-equality guard. The backend rejects unless tier sum
        // equals the resulting total pool exactly, so we mirror that
        // here — the toast points at the real fix instead of the
        // backend's generic "must equal" message.
        const needsTierSumGuard = tiersChanged || siteBonusChanged;
        if (tiersChanged) {
            if (newTiersSorted.length < 5) {
                toast.error("At least 5 prize tiers are required");
                return;
            }
            payload.prize_tiers = newTiersSorted;
        }
        if (needsTierSumGuard && tierSumMismatch) {
            if (tierSumExceeds) {
                toast.error(
                    `Tier sum ($${tierSum.toFixed(2)}) exceeds total prize pool ($${totalPool.toFixed(2)}). Lower the tier amounts or raise the pool.`,
                );
            } else {
                toast.error(
                    `Tier sum ($${tierSum.toFixed(2)}) is below total prize pool ($${totalPool.toFixed(2)}). Raise the tier amounts or lower the pool — the two must match exactly.`,
                );
            }
            return;
        }

        const backendChanged = Object.keys(payload).length > 0;

        // House share % — saved to the admin DB, separately from the
        // backend leaderboard fields above.
        const pctNum = Number(sponsoredPct);
        const sponsoredChanged = pctNum !== (currentSponsoredPct ?? 100);
        if (
            sponsoredChanged &&
            (!Number.isFinite(pctNum) || pctNum < 0 || pctNum > 100)
        ) {
            toast.error("House share % must be between 0 and 100");
            return;
        }

        if (!backendChanged && !sponsoredChanged) {
            toast.info("No changes to save");
            onOpenChange(false);
            return;
        }

        startTransition(async () => {
            if (backendChanged) {
                const r = await editLeaderboard(leaderboard.id, payload);
                if (!r.success) {
                    toast.error(r.error);
                    return;
                }
            }
            if (sponsoredChanged) {
                const r = await setLeaderboardSponsorship(
                    leaderboard.id,
                    pctNum,
                );
                if (!r.success) {
                    toast.error(r.error);
                    return;
                }
            }
            toast.success("Updated");
            onOpenChange(false);
            router.refresh();
        });
    };

    const updateTier = (idx: number, field: "position" | "amount", value: string) => {
        setTiers((prev) =>
            prev.map((t, i) => (i === idx ? { ...t, [field]: value } : t)),
        );
    };

    const addTier = () => {
        const nextPos = tiers.length === 0
            ? 1
            : Math.max(...tiers.map((t) => Number(t.position) || 0)) + 1;
        setTiers((prev) => [...prev, { position: String(nextPos), amount: "" }]);
    };

    const removeTier = (idx: number) => {
        setTiers((prev) => prev.filter((_, i) => i !== idx));
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-2xl">
                <DialogHeader>
                    <DialogTitle>Edit leaderboard</DialogTitle>
                    <DialogDescription>
                        Edit any field. The site-funded pool can be raised or
                        lowered. The prize-tier sum must equal the resulting
                        total pool (creator-funded + site-funded) exactly —
                        use the &ldquo;Scale tiers to pool&rdquo; button to
                        snap them into alignment.
                    </DialogDescription>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="space-y-2">
                        <Label htmlFor="title">Title</Label>
                        <Input
                            id="title"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            maxLength={100}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="codes">Affiliate codes (comma-separated, leave empty for all)</Label>
                        <Input
                            id="codes"
                            value={codesText}
                            onChange={(e) => setCodesText(e.target.value)}
                            placeholder="zog, packy"
                        />
                    </div>

                    <div className="space-y-2">
                        <Label htmlFor="co_creator_search">
                            Co-creators (their codes also count toward this leaderboard)
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
                                                        c.userId !== leaderboard.creator_user_id &&
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

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="space-y-2">
                            <Label htmlFor="start_date">Start (whole hour only)</Label>
                            <Input
                                id="start_date"
                                type="datetime-local"
                                step={3600}
                                value={startDate}
                                onChange={(e) => setStartDate(e.target.value)}
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="end_date">End (whole hour only)</Label>
                            <Input
                                id="end_date"
                                type="datetime-local"
                                step={3600}
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                            />
                        </div>
                    </div>
                    <p className="text-xs text-muted-foreground -mt-2">
                        Leaderboard times must align to whole hours (e.g. 17:00, 18:00). Snapshot
                        and cache jobs run on hourly ticks.
                    </p>

                    {/* Total prize pool (site-funded portion) — editable
                        so admins can shrink a leaderboard after
                        creation. The creator-funded part is locked at
                        deal time; only the site-funded portion can be
                        adjusted here. Total = creator + site. */}
                    <div className="space-y-2">
                        <Label htmlFor="site_bonus_usd">
                            Site-funded pool (USD)
                        </Label>
                        <Input
                            id="site_bonus_usd"
                            type="number"
                            min={0}
                            step="0.01"
                            value={siteBonus}
                            onChange={(e) => setSiteBonus(e.target.value)}
                            placeholder="5000"
                        />
                        <p className="text-xs text-muted-foreground">
                            {Number(leaderboard.creator_prize_usd) > 0 ? (
                                <>
                                    Creator-funded ${Number(leaderboard.creator_prize_usd).toFixed(2)} (locked) +
                                    site-funded ${siteBonusNum.toFixed(2)} = total ${totalPool.toFixed(2)}.
                                </>
                            ) : (
                                <>
                                    Total prize pool = ${totalPool.toFixed(2)}.
                                </>
                            )}
                            {Math.abs(totalPool - originalPool) > 1e-6 && (
                                <>
                                    {" "}
                                    <span
                                        className={
                                            totalPool < originalPool
                                                ? "text-rose-600 dark:text-rose-400"
                                                : "text-emerald-600 dark:text-emerald-400"
                                        }
                                    >
                                        ({totalPool < originalPool ? "−" : "+"}
                                        ${Math.abs(totalPool - originalPool).toFixed(2)} vs current)
                                    </span>
                                </>
                            )}
                        </p>
                    </div>

                    <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                <Label>Prize tiers</Label>
                                {tierSumMismatch && (
                                    <Button
                                        type="button"
                                        variant="outline"
                                        size="sm"
                                        className="h-6 px-2 text-[10px]"
                                        onClick={() => {
                                            // Auto-scale every tier
                                            // proportionally so the sum
                                            // lands exactly on the new
                                            // pool. Zero-sum guard
                                            // distributes evenly when
                                            // every tier is empty.
                                            const current = tiers.reduce(
                                                (acc, t) =>
                                                    acc +
                                                    (Number(t.amount) || 0),
                                                0,
                                            );
                                            const target = totalPool;
                                            if (target <= 0) return;
                                            const next = tiers.map((t) => {
                                                if (current > 0) {
                                                    const scaled =
                                                        (Number(t.amount) ||
                                                            0) *
                                                        (target / current);
                                                    return {
                                                        ...t,
                                                        amount: scaled.toFixed(
                                                            2,
                                                        ),
                                                    };
                                                }
                                                // Empty tiers → spread the
                                                // pool evenly so the admin
                                                // gets a sensible
                                                // starting point.
                                                return {
                                                    ...t,
                                                    amount: (
                                                        target / tiers.length
                                                    ).toFixed(2),
                                                };
                                            });
                                            // Floating-point drift: nudge
                                            // the largest tier by the
                                            // residual so the rounded sum
                                            // matches exactly.
                                            const rounded = next.reduce(
                                                (acc, t) =>
                                                    acc +
                                                    (Number(t.amount) || 0),
                                                0,
                                            );
                                            const residual = target - rounded;
                                            if (
                                                Math.abs(residual) > 0.001 &&
                                                next.length > 0
                                            ) {
                                                let largestIdx = 0;
                                                for (
                                                    let i = 1;
                                                    i < next.length;
                                                    i++
                                                ) {
                                                    if (
                                                        Number(
                                                            next[i].amount,
                                                        ) >
                                                        Number(
                                                            next[largestIdx]
                                                                .amount,
                                                        )
                                                    ) {
                                                        largestIdx = i;
                                                    }
                                                }
                                                next[largestIdx] = {
                                                    ...next[largestIdx],
                                                    amount: (
                                                        Number(
                                                            next[largestIdx]
                                                                .amount,
                                                        ) + residual
                                                    ).toFixed(2),
                                                };
                                            }
                                            setTiers(next);
                                        }}
                                    >
                                        Scale tiers to pool
                                    </Button>
                                )}
                            </div>
                            <span
                                className={
                                    tierSumMismatch
                                        ? "text-xs font-medium text-destructive"
                                        : "text-xs font-medium text-emerald-600 dark:text-emerald-400"
                                }
                            >
                                Sum: ${tierSum.toFixed(2)} / ${totalPool.toFixed(2)}
                                {tierSumMismatch && (
                                    <span className="ml-1">
                                        ({sumDelta > 0 ? "+" : ""}
                                        ${sumDelta.toFixed(2)})
                                    </span>
                                )}
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

                    {/* House share % — admin-side cost-accounting input.
                        Saved to the admin DB, NOT the backend leaderboard;
                        it weights this leaderboard in the /creators
                        Leaderboard Cost KPI. */}
                    <div className="space-y-2">
                        <Label htmlFor="sponsored_pct">
                            House share % (cost math only)
                        </Label>
                        <Input
                            id="sponsored_pct"
                            type="number"
                            min={0}
                            max={100}
                            step="1"
                            value={sponsoredPct}
                            onChange={(e) => setSponsoredPct(e.target.value)}
                            placeholder="100"
                        />
                        <p className="text-xs text-muted-foreground">
                            The portion of this prize pool the house pays
                            on-site. The rest is the creator&apos;s
                            off-site contribution. Weights the /creators
                            Leaderboard Cost KPI; doesn&apos;t change the
                            leaderboard itself. Default 100%.
                        </p>
                    </div>

                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={isPending}
                            className="w-full sm:w-auto"
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            disabled={isPending || tierSumMismatch || siteBonusInvalid}
                            className="w-full sm:w-auto"
                        >
                            {isPending ? "Saving..." : "Save"}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
