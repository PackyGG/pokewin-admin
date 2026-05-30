"use client";

import * as React from "react";

/**
 * Shared state for the right-edge widget rail. The LiveMoneyChat (top
 * slot) and DockedChat (bottom slot) both read + write this so they
 * stay in sync — collapsing the live feed pulls the chat up to fill
 * the freed space; expanding live pushes chat back into the bottom
 * half. Without a shared store the two panels would have to either
 * poll localStorage or fight over independent state.
 *
 * Persisted across reloads + pages via localStorage so an admin who
 * minimized either panel returns to the same layout on the next
 * load. SSR-safe: defaults to "both open" until the mount effect
 * reads the stored values.
 */

type RightRailState = {
    liveOpen: boolean;
    setLiveOpen: (v: boolean) => void;
    chatOpen: boolean;
    setChatOpen: (v: boolean) => void;
};

const RightRailCtx = React.createContext<RightRailState | null>(null);

// Storage keys must stay stable — older mounted-elsewhere code may
// have written under these names too, and we want the saved state to
// roundtrip through the refactor.
const STORAGE_LIVE = "live-money-chat:open";
const STORAGE_CHAT = "docked-chat:open";

export function RightRailProvider({ children }: { children: React.ReactNode }) {
    const [liveOpen, setLiveOpenState] = React.useState(true);
    const [chatOpen, setChatOpenState] = React.useState(true);

    // Restore persisted state once on mount. The initial SSR render
    // assumes both open; we silently flip to the stored value on
    // hydration (the brief default-open flash is visually quiet
    // because the panels share the same chrome).
    React.useEffect(() => {
        if (typeof window === "undefined") return;
        const live = window.localStorage.getItem(STORAGE_LIVE);
        if (live === "0") setLiveOpenState(false);
        const chat = window.localStorage.getItem(STORAGE_CHAT);
        if (chat === "0") setChatOpenState(false);
    }, []);

    const setLiveOpen = React.useCallback((v: boolean) => {
        setLiveOpenState(v);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_LIVE, v ? "1" : "0");
        }
    }, []);

    const setChatOpen = React.useCallback((v: boolean) => {
        setChatOpenState(v);
        if (typeof window !== "undefined") {
            window.localStorage.setItem(STORAGE_CHAT, v ? "1" : "0");
        }
    }, []);

    const value = React.useMemo(
        () => ({ liveOpen, setLiveOpen, chatOpen, setChatOpen }),
        [liveOpen, setLiveOpen, chatOpen, setChatOpen],
    );

    return <RightRailCtx.Provider value={value}>{children}</RightRailCtx.Provider>;
}

export function useRightRail(): RightRailState {
    const ctx = React.useContext(RightRailCtx);
    if (!ctx) {
        // Defensive default — lets a widget render outside the provider
        // (e.g. a Storybook story or test) without crashing. The
        // setters become no-ops; state is "always open".
        return {
            liveOpen: true,
            setLiveOpen: () => {},
            chatOpen: true,
            setChatOpen: () => {},
        };
    }
    return ctx;
}

// Layout constants — exported so both panels resolve their `top` /
// `bottom` from the same values and the geometry stays in sync.
//
// When BOTH panels are open the right edge splits at the viewport
// midpoint. When live is COLLAPSED its thin tab occupies the top
// `COLLAPSED_LIVE_HEIGHT_REM` rem and the chat panel takes everything
// below it (so chat slides UP to fill the freed space).
export const RAIL_TOP_REM = 5; // matches `top-20` (under the admin header)
export const RAIL_BOTTOM_REM = 1.5; // matches `bottom-6`
export const COLLAPSED_LIVE_HEIGHT_REM = 7; // fixed live-tab height
export const PANEL_GAP_REM = 0.25; // breathing room between stacked panels

/**
 * Where the docked-chat panel (or its collapsed tab) starts. Resolves
 * to a CSS `top` value string suitable for inline-style usage.
 *
 *   - live OPEN   → chat starts at the viewport midpoint (bottom half)
 *   - live CLOSED → chat starts just below live's collapsed tab so it
 *                   takes most of the right edge
 */
export function chatTopCss(liveOpen: boolean): string {
    if (liveOpen) {
        return `calc(50vh + ${PANEL_GAP_REM}rem)`;
    }
    return `calc(${RAIL_TOP_REM}rem + ${COLLAPSED_LIVE_HEIGHT_REM}rem + ${PANEL_GAP_REM}rem)`;
}
