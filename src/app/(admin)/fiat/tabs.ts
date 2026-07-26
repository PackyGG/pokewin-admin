export const FIAT_TABS = [
  "overview",
  "configuration",
  "payments",
  "access",
  "webhooks",
] as const;

export type FiatTab = (typeof FIAT_TABS)[number];

export function parseFiatTab(value: string | undefined): FiatTab {
  return (FIAT_TABS as readonly string[]).includes(value ?? "")
    ? (value as FiatTab)
    : "overview";
}
