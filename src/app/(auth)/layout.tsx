/**
 * Auth (login / 2FA) layout.
 *
 * Forced Grailed: the root wrapper carries the `grailed` class, so the whole
 * auth subtree resolves the Grailed indigo/cyan tokens (defined by the
 * `.grailed` rule in globals.css) AND fires every `dark:` utility (the `dark`
 * custom-variant matches `.grailed *`) — regardless of the visitor's chosen
 * theme on <html>. `.grailed` also sets `color-scheme: dark`, so native
 * controls render dark. No next-themes involvement, so there's no flash and no
 * interaction with the app-wide theme toggle. Pure Server Component — no
 * client JS ships for the shell.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="grailed relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      {/* Premium Grailed backdrop — a deep indigo top-lit vignette, two soft
          color glows (cyan primary + blue accent) and a faint masked grid.
          Every layer is static (no animation), so it's inherently
          reduced-motion safe, and decorative + inert (aria-hidden,
          pointer-events-none). Colors come from Grailed tokens. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(125%_125%_at_50%_-10%,var(--card),var(--background)_45%,var(--sidebar))]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.15] [background-image:linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [background-size:46px_46px] [mask-image:radial-gradient(circle_at_50%_38%,black,transparent_72%)]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 -left-40 size-[32rem] rounded-full bg-primary/20 blur-[130px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 -bottom-48 size-[34rem] rounded-full bg-chart-5/15 blur-[140px]"
      />
      <div className="relative z-10 w-full max-w-[460px]">{children}</div>
    </div>
  );
}
