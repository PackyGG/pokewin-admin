export function toNumber(value: unknown): number {
  if (value == null) return 0;
  const n = Number(
    typeof value === "object" && "toFixed" in (value as object)
      ? String(value)
      : value
  );
  return Number.isNaN(n) ? 0 : n;
}

export function toFixed(value: unknown, decimals = 2): string {
  return toNumber(value).toFixed(decimals);
}
