/**
 * Route-level skeleton — mirrors the page's own `BodySkeleton` so navigating
 * in and the streamed swap look identical (no layout jump). The Hub page has
 * no hero (the Hub sidebar carries the page identity), so this is body-only.
 */
export default function Loading() {
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="h-9 w-56 animate-pulse rounded-lg bg-muted" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-2xl border bg-muted/30"
          />
        ))}
      </div>
    </div>
  );
}
