"use client";

export function EmptyLever({ note }: { note: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-6 text-center text-xs leading-relaxed text-muted-foreground">
      {note}
    </div>
  );
}

function formatPercentInt(pct: number): string {
  return `${Math.round(pct)}%`;
}

export { formatPercentInt };
