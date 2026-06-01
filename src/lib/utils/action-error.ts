import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Next.js control-flow error handling (client-side)
// ---------------------------------------------------------------------------
//
// `redirect()` and `notFound()` work by throwing a special error that Next
// catches to perform navigation. When a Server Action called from a client
// component (inside startTransition) hits one of these — e.g. an expired
// session in `requireAdmin()` → `redirect("/login")` — the error propagates
// into the client's try/catch. A naive `catch { toast.error(e.message) }`
// then surfaces Next's internal digest ("NEXT_REDIRECT") as a bogus error
// toast, AND the navigation still happens.
//
// The fix: detect these control-flow signals and re-throw them so Next can
// complete the redirect/notFound cleanly, with no error toast.
//
// Detection strategy — digest string prefix:
//   redirect():  digest === "NEXT_REDIRECT;<type>;<url>;<status>;"
//   notFound():  digest === "NEXT_HTTP_ERROR_FALLBACK;<status>"
// These prefixes are part of Next's contract and are stable across patch
// releases. The official `isRedirectError` / `isHTTPAccessFallbackError`
// helpers are NOT re-exported from the public `next/navigation` entrypoint
// (only from internal `next/dist/...` paths that move between versions), so
// the digest-string guard is the reliable, public-API-free check. This file
// stays client-safe — it imports nothing server-only.

const REDIRECT_DIGEST_PREFIX = "NEXT_REDIRECT";
const NOT_FOUND_DIGEST_PREFIX = "NEXT_HTTP_ERROR_FALLBACK";

/**
 * True when `e` is a Next.js control-flow signal (`redirect()` /
 * `notFound()`) rather than a real error. Such errors must be re-thrown so
 * Next can perform the navigation; they must never be shown as a toast.
 */
export function isNextControlFlowError(e: unknown): boolean {
  const digest = (e as { digest?: unknown } | null | undefined)?.digest;
  if (typeof digest !== "string") return false;
  return (
    digest === REDIRECT_DIGEST_PREFIX ||
    digest.startsWith(`${REDIRECT_DIGEST_PREFIX};`) ||
    digest === NOT_FOUND_DIGEST_PREFIX ||
    digest.startsWith(`${NOT_FOUND_DIGEST_PREFIX};`)
  );
}

/**
 * Standard client-side catch handler for Server Action calls. Re-throws
 * Next.js control-flow errors (so the redirect/notFound runs cleanly) and
 * shows everything else as an error toast.
 *
 * Usage:
 *   } catch (e) {
 *     toastActionError(e, "Failed to create card");
 *   }
 *
 * @throws the original error if it is a Next control-flow signal.
 */
export function toastActionError(e: unknown, fallbackMessage: string): void {
  if (isNextControlFlowError(e)) throw e;
  toast.error(e instanceof Error ? e.message : fallbackMessage);
}
