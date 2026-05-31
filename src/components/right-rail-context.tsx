"use client";

import * as React from "react";

/**
 * Shared state for the right-edge widget rail. Three docked widgets live
 * on the right edge of the admin shell:
 *
 *   • Live  (LiveMoneyChat)        — top slot
 *   • Recent (DockedRecentActivity) — middle slot
 *   • Chat  (DockedChat)            — bottom slot
 *
 * Order is fixed (top → bottom: live → recent → chat); each widget reads
 * + writes its open/closed state through this context so the three stay
 * in sync — collapsing one frees up rail space; expanding another reflows
 * the layout. Without a shared store the panels would fight over
 * independent state.
 *
 * ─── At-most-2-open rule ────────────────────────────────────────────────
 * To keep the rail readable on shorter laptop screens, at most TWO of the
 * three panels may be expanded at the same time. The context tracks the
 * insertion order of opens (`openOrder`) and, when a user expands a third
 * panel, evicts the OLDEST-opened one (FIFO) before opening the new one.
 * Widgets call `toggle(key)` through `useRailWidget(key)` — they don't
 * have to know about each other.
 *
 * Persisted across reloads + pages via localStorage so an admin who
 * minimized a panel returns to the same layout on the next load. SSR-safe:
 * defaults to "live + chat open" (the historical layout before recent was
 * added) until the mount effect reads the stored values.
 */

export const RAIL_KEYS = ["live", "recent", "chat"] as const;
export type RailKey = (typeof RAIL_KEYS)[number];

type RailState = {
    /** Open/closed flag per widget. */
    open: Record<RailKey, boolean>;
    /** Insertion order of currently-open widgets — used for FIFO eviction
     *  when a 3rd would be opened. */
    openOrder: RailKey[];
};

type RightRailState = {
    open: Record<RailKey, boolean>;
    /** Which widgets are actually MOUNTED in the layout. A non-admin user
     *  without chat permission won't have `<DockedChat />` rendered — and
     *  the geometry calcs need to know so they don't reserve empty space
     *  for the unmounted slot. */
    mounted: Record<RailKey, boolean>;
    /** Imperatively set a widget's open state. If the call would result in
     *  three open widgets, the oldest-opened one is evicted first. */
    setOpen: (key: RailKey, next: boolean) => void;
};

const RightRailCtx = React.createContext<RightRailState | null>(null);

// Storage keys must stay stable — older mounted-elsewhere code may have
// written under these names too, and we want the saved state to roundtrip
// through the refactor. The "open order" persists under its own key so we
// can restore FIFO eviction across reloads.
const STORAGE_KEYS: Record<RailKey, string> = {
    live: "live-money-chat:open",
    recent: "docked-recent-activity:open",
    chat: "docked-chat:open",
};
const STORAGE_ORDER = "right-rail:open-order";

// Default open state: live + chat (the historical layout before the
// recent activity widget was added). Recent defaults to closed so existing
// users don't see three widgets eat their rail on first load — they can
// opt in.
const DEFAULT_OPEN: Record<RailKey, boolean> = {
    live: true,
    recent: false,
    chat: true,
};

/**
 * Apply the at-most-2 rule to an arbitrary state. If `openOrder` has more
 * than 2 entries, evict from the head (oldest first) until it fits.
 * Returns a NEW state object — never mutates `state`.
 */
function enforceAtMostTwo(state: RailState): RailState {
    if (state.openOrder.length <= 2) return state;
    const trimmedOrder = [...state.openOrder];
    const open = { ...state.open };
    while (trimmedOrder.length > 2) {
        const evicted = trimmedOrder.shift()!;
        open[evicted] = false;
    }
    return { open, openOrder: trimmedOrder };
}

/**
 * Apply a single open/close toggle to the rail state. Handles the FIFO
 * eviction when opening would result in 3 open widgets. Pure function —
 * easy to reason about and test.
 */
function applyToggle(state: RailState, key: RailKey, next: boolean): RailState {
    // No-op if the target value matches the current value.
    if (state.open[key] === next) return state;
    if (!next) {
        // Closing — drop the key from openOrder.
        return {
            open: { ...state.open, [key]: false },
            openOrder: state.openOrder.filter((k) => k !== key),
        };
    }
    // Opening — append to openOrder, then enforce the at-most-2 rule
    // (evicts the oldest-opened widget if necessary).
    const tentative: RailState = {
        open: { ...state.open, [key]: true },
        openOrder: [...state.openOrder.filter((k) => k !== key), key],
    };
    return enforceAtMostTwo(tentative);
}

function readStoredState(): RailState {
    if (typeof window === "undefined") {
        return {
            open: { ...DEFAULT_OPEN },
            openOrder: RAIL_KEYS.filter((k) => DEFAULT_OPEN[k]),
        };
    }
    const open: Record<RailKey, boolean> = { ...DEFAULT_OPEN };
    for (const key of RAIL_KEYS) {
        const stored = window.localStorage.getItem(STORAGE_KEYS[key]);
        if (stored === "1") open[key] = true;
        else if (stored === "0") open[key] = false;
    }
    // Read the persisted insertion order. Anything stored under a key we
    // don't recognise — or that disagrees with `open` — is filtered out so
    // a corrupted entry can't crash the rail.
    const openOrder: RailKey[] = [];
    const rawOrder = window.localStorage.getItem(STORAGE_ORDER);
    if (rawOrder) {
        try {
            const parsed = JSON.parse(rawOrder);
            if (Array.isArray(parsed)) {
                const seen = new Set<RailKey>();
                for (const item of parsed) {
                    if (
                        typeof item === "string" &&
                        (RAIL_KEYS as readonly string[]).includes(item) &&
                        !seen.has(item as RailKey) &&
                        open[item as RailKey]
                    ) {
                        openOrder.push(item as RailKey);
                        seen.add(item as RailKey);
                    }
                }
            }
        } catch {
            // Corrupted JSON — ignore and rebuild from `open` below.
        }
    }
    // Backfill order for any currently-open widget that wasn't in the
    // stored order (e.g. fresh user with no STORAGE_ORDER yet). Insert in
    // the canonical slot order so the layout is deterministic.
    for (const key of RAIL_KEYS) {
        if (open[key] && !openOrder.includes(key)) openOrder.push(key);
    }
    return enforceAtMostTwo({ open, openOrder });
}

export function RightRailProvider({
    children,
    /** Per-widget mount flag — the layout shell passes `chat: false` when
     *  the current user doesn't have the permission boundary to see the
     *  chat dock, so the rail geometry doesn't reserve dead space for it. */
    mounted,
}: {
    children: React.ReactNode;
    mounted?: Partial<Record<RailKey, boolean>>;
}) {
    // Coalesce the optional `mounted` prop into a fully-populated record so
    // every callsite can read `mounted[key]` without a null-check. Missing
    // keys default to true (the widget IS mounted).
    const resolvedMounted = React.useMemo<Record<RailKey, boolean>>(
        () => ({
            live: mounted?.live ?? true,
            recent: mounted?.recent ?? true,
            chat: mounted?.chat ?? true,
        }),
        [mounted?.live, mounted?.recent, mounted?.chat],
    );

    // SSR default mirrors the historical layout (live + chat open). On
    // mount we silently flip to the persisted state — the brief default
    // flash is visually quiet because the panels share the same chrome.
    const [state, setState] = React.useState<RailState>(() => ({
        open: { ...DEFAULT_OPEN },
        openOrder: RAIL_KEYS.filter((k) => DEFAULT_OPEN[k]),
    }));

    React.useEffect(() => {
        setState(readStoredState());
    }, []);

    const persist = React.useCallback((next: RailState) => {
        if (typeof window === "undefined") return;
        for (const key of RAIL_KEYS) {
            window.localStorage.setItem(STORAGE_KEYS[key], next.open[key] ? "1" : "0");
        }
        window.localStorage.setItem(STORAGE_ORDER, JSON.stringify(next.openOrder));
    }, []);

    const setOpen = React.useCallback(
        (key: RailKey, next: boolean) => {
            setState((prev) => {
                const updated = applyToggle(prev, key, next);
                persist(updated);
                return updated;
            });
        },
        [persist],
    );

    // Filter the persisted open state through `resolvedMounted` so the
    // value the geometry calc sees treats unmounted slots as collapsed.
    // The underlying `state.open` is preserved as-is — a user who
    // temporarily loses chat access then regains it still gets back the
    // open state they last had.
    const effectiveOpen = React.useMemo<Record<RailKey, boolean>>(
        () => ({
            live: resolvedMounted.live && state.open.live,
            recent: resolvedMounted.recent && state.open.recent,
            chat: resolvedMounted.chat && state.open.chat,
        }),
        [resolvedMounted, state.open],
    );

    const value = React.useMemo<RightRailState>(
        () => ({ open: effectiveOpen, mounted: resolvedMounted, setOpen }),
        [effectiveOpen, resolvedMounted, setOpen],
    );

    return <RightRailCtx.Provider value={value}>{children}</RightRailCtx.Provider>;
}

/**
 * Per-widget binding for the shared right-rail state. Each docked widget
 * calls this with its own key and gets back the open flag + a toggle
 * helper that handles FIFO eviction automatically.
 */
export function useRailWidget(key: RailKey): {
    open: boolean;
    setOpen: (v: boolean) => void;
    /** Open/closed flags for ALL widgets — needed so each widget can
     *  compute its own slot geometry (a panel's `top` / `bottom` depends
     *  on whether the slots above / below are open or collapsed). */
    allOpen: Record<RailKey, boolean>;
    /** Which widgets are MOUNTED in this layout. The geometry helper needs
     *  this so an unmounted slot doesn't reserve dead space — see
     *  `railSlotStyle`. */
    mounted: Record<RailKey, boolean>;
} {
    const ctx = React.useContext(RightRailCtx);
    if (!ctx) {
        // Defensive default — lets a widget render outside the provider
        // (e.g. a Storybook story or test) without crashing. Setter is a
        // no-op; state mirrors DEFAULT_OPEN and assumes all widgets are
        // mounted.
        const allMounted: Record<RailKey, boolean> = { live: true, recent: true, chat: true };
        return {
            open: DEFAULT_OPEN[key],
            setOpen: () => {},
            allOpen: { ...DEFAULT_OPEN },
            mounted: allMounted,
        };
    }
    return {
        open: ctx.open[key],
        setOpen: (v) => ctx.setOpen(key, v),
        allOpen: ctx.open,
        mounted: ctx.mounted,
    };
}

// ── Layout geometry ────────────────────────────────────────────────────
// Layout constants — exported so all three panels resolve their `top` /
// `bottom` / `height` from the same values and the geometry stays in sync.
//
// All three widgets share the same fixed-height collapsed-tab size so the
// rail layout maths stay simple (variable tab heights would force every
// panel's offset to be a calc tree). The previous live/chat-specific tab
// heights are folded into one constant.
export const RAIL_TOP_REM = 5; // matches `top-20` (under the admin header)
export const RAIL_BOTTOM_REM = 1.5; // matches `bottom-6`
export const COLLAPSED_TAB_HEIGHT_REM = 5; // fixed tab height for all 3 widgets
export const PANEL_GAP_REM = 0.25; // breathing room between stacked panels

// Back-compat aliases — existing call sites reference these names. They
// all resolve to the unified COLLAPSED_TAB_HEIGHT_REM now.
export const COLLAPSED_LIVE_HEIGHT_REM = COLLAPSED_TAB_HEIGHT_REM;
export const COLLAPSED_CHAT_HEIGHT_REM = COLLAPSED_TAB_HEIGHT_REM;

/**
 * Slot index for each widget (0 = top, 1 = middle, 2 = bottom). Used to
 * compute the cumulative offsets when resolving each widget's position.
 */
const SLOT_INDEX: Record<RailKey, number> = { live: 0, recent: 1, chat: 2 };

/**
 * Returns the inline-style positioning for a docked rail widget given
 * the current open/closed state of all three widgets. The same function
 * handles both the OPEN panel and the COLLAPSED tab — callers branch on
 * `open[key]` to decide which chrome to render, then spread the returned
 * style onto the wrapping element.
 *
 * Geometry model:
 *   • The rail spans from `top: RAIL_TOP_REM` to `bottom: RAIL_BOTTOM_REM`.
 *   • Each MOUNTED slot is either:
 *     - collapsed → fixed height `COLLAPSED_TAB_HEIGHT_REM`
 *     - open     → shares the remaining vertical space equally with the
 *                  other open slot(s)
 *   • UNMOUNTED slots (e.g. chat for a user without chat permission) are
 *     dropped entirely — they reserve no space, count zero gaps.
 *   • One `PANEL_GAP_REM` gap separates each adjacent pair of MOUNTED
 *     slots.
 *
 * The freeSpace for an open panel is therefore:
 *     `(100vh − rail_top − rail_bottom − sum_collapsed_heights − total_gaps) / num_open`
 *
 * Each widget's top offset is the cumulative height of everything ABOVE
 * its slot (slot heights + gaps); each open widget's bottom offset is the
 * cumulative height of everything BELOW. We express the result with
 * `top` + `bottom` (no inline `height`) so the open panel naturally fills
 * the band between the two anchors.
 */
export function railSlotStyle(
    key: RailKey,
    allOpen: Record<RailKey, boolean>,
    mounted: Record<RailKey, boolean> = { live: true, recent: true, chat: true },
): React.CSSProperties {
    const myIdx = SLOT_INDEX[key];

    // Count open vs collapsed slots ABOVE and BELOW this widget. UNMOUNTED
    // slots are skipped entirely so they reserve no rail space.
    let openAbove = 0;
    let collapsedAbove = 0;
    let openBelow = 0;
    let collapsedBelow = 0;
    for (const k of RAIL_KEYS) {
        if (!mounted[k]) continue;
        const idx = SLOT_INDEX[k];
        if (idx < myIdx) {
            if (allOpen[k]) openAbove += 1;
            else collapsedAbove += 1;
        } else if (idx > myIdx) {
            if (allOpen[k]) openBelow += 1;
            else collapsedBelow += 1;
        }
    }
    const isOpen = allOpen[key];
    const mountedCount =
        (mounted.live ? 1 : 0) + (mounted.recent ? 1 : 0) + (mounted.chat ? 1 : 0);
    const totalOpen = openAbove + openBelow + (isOpen ? 1 : 0);
    const totalCollapsed = mountedCount - totalOpen;
    // One gap per pair of adjacent mounted slots.
    const totalGaps = Math.max(0, mountedCount - 1);

    // CSS calc for the per-open-panel share. With `totalOpen === 0` the
    // expression isn't used (no open panel renders), so divide-by-zero is
    // impossible in practice — we still guard it for type-safety.
    const collapsedHeightRem = totalCollapsed * COLLAPSED_TAB_HEIGHT_REM;
    const totalGapsRem = totalGaps * PANEL_GAP_REM;
    const fixedSubtractedRem =
        RAIL_TOP_REM + RAIL_BOTTOM_REM + collapsedHeightRem + totalGapsRem;
    const freeSpaceCss = `(100vh - ${fixedSubtractedRem}rem)`;
    const openShareCss =
        totalOpen > 0 ? `(${freeSpaceCss} / ${totalOpen})` : freeSpaceCss;

    // Top offset = RAIL_TOP + (sum of slot heights above) + (gaps above).
    // Each "above" mounted slot contributes exactly one gap (between it
    // and the next mounted slot down).
    const slotsAbove = collapsedAbove + openAbove;
    const collapsedAboveRem = collapsedAbove * COLLAPSED_TAB_HEIGHT_REM;
    const gapsAboveRem = slotsAbove * PANEL_GAP_REM;
    const topFixedRem = RAIL_TOP_REM + collapsedAboveRem + gapsAboveRem;
    const topParts: string[] = [`${topFixedRem}rem`];
    if (openAbove > 0) {
        topParts.push(`(${openAbove} * ${openShareCss})`);
    }
    const topCss = `calc(${topParts.join(" + ")})`;

    if (isOpen) {
        // Bottom offset = RAIL_BOTTOM + (sum of slot heights below) +
        // (one gap per mounted slot below — same symmetry as the top
        // calc).
        const slotsBelow = collapsedBelow + openBelow;
        const collapsedBelowRem = collapsedBelow * COLLAPSED_TAB_HEIGHT_REM;
        const gapsBelowRem = slotsBelow * PANEL_GAP_REM;
        const bottomFixedRem = RAIL_BOTTOM_REM + collapsedBelowRem + gapsBelowRem;
        const bottomParts: string[] = [`${bottomFixedRem}rem`];
        if (openBelow > 0) {
            bottomParts.push(`(${openBelow} * ${openShareCss})`);
        }
        const bottomCss = `calc(${bottomParts.join(" + ")})`;
        return { top: topCss, bottom: bottomCss };
    }
    // Collapsed tab — fixed height anchored at its slot's top offset. We
    // include `height` so the tab is a known size regardless of content.
    return { top: topCss, height: `${COLLAPSED_TAB_HEIGHT_REM}rem` };
}

// ── Back-compat shims ──────────────────────────────────────────────────
// The old `useRightRail` + `chatTopCss` / `liveBottomCss` / `chatTabAnchor`
// API is gone — every docked widget reads `useRailWidget` + `railSlotStyle`
// now. The constants above (COLLAPSED_*_HEIGHT_REM, RAIL_TOP_REM, etc.)
// remain re-exported so legacy imports still resolve.
