import { formatCurrency } from "@/lib/utils/format";

export function multLabel(m: number): string {
  return `${m.toFixed(2)}×`;
}

export function formatEvUsd(n: number): string {
  if (n >= 100) return formatCurrency(n);
  return `$${n.toFixed(2)}`;
}
