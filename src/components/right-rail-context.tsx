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
// midpoint. When one is COLLAPSED its thin tab occupies a fixed
// height and the other panel expands to take everything else.
export const RAIL_TOP_REM = 5; // matches `top-20` (under the admin header)
export const RAIL_BOTTOM_REM = 1.5; // matches `bottom-6`
export const COLLAPSED_LIVE_HEIGHT_REM = 7; // fixed live-tab height
export const COLLAPSED_CHAT_HEIGHT_REM = 6; // fixed chat-tab height
export const PANEL_GAP_REM = 0.25; // breathing room between stacked panels

/**
 * Where the docked-chat panel (or its collapsed tab) starts when it's
 * positioned with `top:`. Resolves to a CSS value suitable for inline
 * `style.top` usage.
 *
 *   - chat OPEN, live OPEN   → midpoint (bottom half)
 *   - chat OPEN, live CLOSED → just below live's collapsed tab (chat
 *                              takes the full remaining height)
 *   - chat CLOSED, live OPEN → not used; the collapsed tab sticks to
 *                              the BOTTOM of the rail instead (see
 *                              `chatTabUsesBottom`)
 *   - chat CLOSED, live CLOSED → just below live's collapsed tab so
 *                                the two tabs stack from the top
 */
export function chatTopCss(liveOpen: boolean): string {
    if (liveOpen) {
        return `calc(50vh + ${PANEL_GAP_REM}rem)`;
    }
    return `calc(${RAIL_TOP_REM}rem + ${COLLAPSED_LIVE_HEIGHT_REM}rem + ${PANEL_GAP_REM}rem)`;
}

/**
 * Where the live-money panel ends (its CSS `bottom`).
 *
 *   - chat OPEN  → midpoint (top half, leaves the bottom half for chat)
 *   - chat CLOSED → just above chat's collapsed tab at the bottom of
 *                   the rail (live expands DOWN to fill the freed
 *                   space — symmetric with chat expanding UP when
 *                   live is collapsed)
 */
export function liveBottomCss(chatOpen: boolean): string {
    if (chatOpen) {
        return `calc(50vh + ${PANEL_GAP_REM}rem)`;
    }
    return `calc(${RAIL_BOTTOM_REM}rem + ${COLLAPSED_CHAT_HEIGHT_REM}rem + ${PANEL_GAP_REM}rem)`;
}

/**
 * Chat's collapsed tab anchors differently depending on the live
 * panel's state. When live is open and taking most of the rail, the
 * chat tab sticks to the BOTTOM of the rail (out of live's way). When
 * live is collapsed, the chat tab anchors via `top:` right below
 * live's tab so the two stack from the top.
 *
 * Returns the inline-style object both anchors can spread into the
 * tab button.
 */
export function chatTabAnchor(liveOpen: boolean): React.CSSProperties {
    if (liveOpen) {
        return { bottom: `${RAIL_BOTTOM_REM}rem` };
    }
    return { top: chatTopCss(false) };
}
