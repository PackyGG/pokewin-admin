import * as React from "react";
import { toast } from "sonner";

import type { ServerActionResult } from "@/lib/errors/server-action-result";

/**
 * useToggleAction — optimistic, no-reload wrapper for an in-place boolean toggle
 * backed by a Server Action.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS (the scroll-jump bug it fixes)
 * ──────────────────────────────────────────────────────────────────────
 * The anti-pattern this replaces: a client toggle calls a server action, then
 * `router.refresh()`. `router.refresh()` re-fetches AND re-renders the whole
 * route — every server component on the page re-runs, `FadeIn`/animations
 * replay, and the browser loses the user's scroll position (they get dumped at
 * a "random spot"). For a control whose only visible effect is flipping ONE
 * badge/button, that full-route churn is both wrong and jarring.
 *
 * The fix: flip a LOCAL optimistic value the instant the user acts (no reload),
 * and let the server stay source of truth through a NARROW `revalidateTag` on
 * the specific list cache — never a broad `revalidatePath` of the whole page,
 * never `router.refresh()`. When that narrow revalidation streams fresh props
 * in, the effect below re-syncs local state so the two never drift.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  THE TWO NON-NEGOTIABLES (do not break these when adopting the hook)
 * ──────────────────────────────────────────────────────────────────────
 *  (a) NO `router.refresh()` for an in-place toggle. This hook never calls it,
 *      and callers must not add it back. The optimistic flip IS the UI update;
 *      a refresh would re-introduce the exact scroll-jump / re-render churn we
 *      are removing.
 *  (b) SERVER STAYS SOURCE OF TRUTH via a NARROW `revalidateTag`, and a FAILED
 *      action ROLLS BACK. The optimistic value is provisional: on
 *      `!result.success` we restore the previous value and toast the error, so
 *      the badge never lies about persisted state. The server action should
 *      bust only the specific list tag (e.g. `revalidateTag(SOME_LIST_TAG)`),
 *      not `revalidatePath` the whole route — that keeps other surfaces correct
 *      without forcing a visible re-render here.
 *
 * ──────────────────────────────────────────────────────────────────────
 *  MECHANICS
 * ──────────────────────────────────────────────────────────────────────
 *  • Built on React 19 built-ins only: `useState` for the optimistic value +
 *    `useTransition` for the pending flag (no `useOptimistic` needed here —
 *    the toggle is a deliberate confirmed action, not an in-flight form field,
 *    so a plain state flip with manual rollback is the clearest fit and keeps
 *    the value stable across the async action rather than snapping back the
 *    moment the transition settles).
 *  • `serverValue` is the server-truth seed (the current persisted boolean). If
 *    a real revalidation changes it, the effect re-syncs `value` to it — as
 *    long as no toggle is mid-flight (guarded by `isPending`) so an in-progress
 *    optimistic flip is never clobbered by a stale prop.
 *  • `toggle()` computes the next value, flips it locally at once, runs the
 *    caller-supplied action for that next value, and on failure rolls back +
 *    `toast.error(result.error)`. On success it toasts the caller's message
 *    (which may depend on the value it flipped TO).
 *
 * ──────────────────────────────────────────────────────────────────────
 *  USAGE
 * ──────────────────────────────────────────────────────────────────────
 *   const { value, pending, toggle } = useToggleAction({
 *     serverValue: unlocked,
 *     action: (next) =>
 *       next ? unlockUserWithdrawals({ userId }) : relockUserWithdrawals(userId),
 *     successMessage: (next) =>
 *       next ? "Withdrawals unlocked" : "Withdrawals re-locked",
 *   });
 *   // render the badge/button from `value`; disable while `pending`; call
 *   // `toggle()` on confirm. NEVER call router.refresh() alongside it.
 */
export type UseToggleActionOptions<T = unknown> = {
  /**
   * Server-truth seed — the currently persisted boolean. Pass the prop that
   * comes from the server component so a narrow revalidation re-syncs cleanly.
   */
  serverValue: boolean;
  /**
   * The Server Action to run for the NEXT value. Receives the value the toggle
   * is flipping TO (`true` = turning on, `false` = turning off) so the caller
   * can pick the right action, and MUST resolve to the house
   * {@link ServerActionResult} shape. On `!result.success` the hook rolls the
   * optimistic value back and toasts `result.error`.
   */
  action: (next: boolean) => Promise<ServerActionResult<T>>;
  /**
   * Success toast message. A string is shown verbatim; a function receives the
   * value that was flipped TO so the copy can differ per direction
   * ("Unlocked" vs "Re-locked"). Return an empty string to suppress the toast.
   */
  successMessage: string | ((next: boolean) => string);
  /**
   * Fallback error toast when the action THROWS (as opposed to returning a
   * structured `fail`). A returned `{ success: false }` uses `result.error`;
   * this only covers an unexpected throw crossing the boundary.
   */
  errorMessage?: string;
  /**
   * Optional callback fired after a SUCCESSFUL toggle, with the value flipped
   * TO. Handy to close a confirmation dialog. Not fired on failure.
   */
  onSuccess?: (next: boolean) => void;
  /**
   * Optional callback fired after a FAILED toggle (structured fail OR throw),
   * with the value that was ROLLED BACK to. Handy to close a dialog on error
   * too. The error toast is already shown by the hook.
   */
  onError?: (rolledBackTo: boolean) => void;
};

export type UseToggleActionReturn = {
  /** The current (optimistic) boolean to drive the badge/button. */
  value: boolean;
  /** True while the action is in flight — use to disable the control. */
  pending: boolean;
  /** Invoke to flip the value optimistically and run the action. */
  toggle: () => void;
};

export function useToggleAction<T = unknown>({
  serverValue,
  action,
  successMessage,
  errorMessage = "Something went wrong — please try again.",
  onSuccess,
  onError,
}: UseToggleActionOptions<T>): UseToggleActionReturn {
  const [value, setValue] = React.useState(serverValue);
  const [pending, startTransition] = React.useTransition();

  // Re-sync to the server-truth prop when a genuine revalidation streams a new
  // value in — but NEVER while a toggle is mid-flight, or the stale pre-mutation
  // prop would clobber the in-progress optimistic flip. Once the narrow
  // revalidateTag lands, `serverValue` matches what we already flipped to, so
  // this is a no-op in the happy path and only corrects real external drift.
  React.useEffect(() => {
    if (pending) return;
    setValue(serverValue);
  }, [serverValue, pending]);

  const toggle = React.useCallback(() => {
    const next = !value;
    // Optimistic flip — instant, no reload.
    setValue(next);
    startTransition(async () => {
      try {
        const result = await action(next);
        if (!result.success) {
          // Roll back to server truth and surface the structured error.
          setValue(serverValue);
          toast.error(result.error);
          onError?.(serverValue);
          return;
        }
        const msg =
          typeof successMessage === "function"
            ? successMessage(next)
            : successMessage;
        if (msg) toast.success(msg);
        onSuccess?.(next);
      } catch (e) {
        // Unexpected throw across the RSC boundary — roll back + generic toast.
        setValue(serverValue);
        toast.error(e instanceof Error ? e.message : errorMessage);
        onError?.(serverValue);
      }
    });
  }, [value, serverValue, action, successMessage, errorMessage, onSuccess, onError]);

  return { value, pending, toggle };
}
