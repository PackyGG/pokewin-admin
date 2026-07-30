import { ShieldAlert } from "lucide-react";

const NETWORK_LABELS: Record<string, string> = {
  proxy: "Proxy",
  vpn: "VPN",
  tor: "Tor",
  compromised: "Compromised IP",
  scraper: "Scraper",
  hosting: "Hosting",
  residential_proxy: "Residential proxy",
};

const SIGNAL_LABELS: Record<string, string> = {
  fingerprint_proxy: "Proxy",
  fingerprint_vpn: "VPN",
  fingerprint_tor: "Tor",
  abstract_ip_proxy: "Proxy",
  abstract_ip_vpn: "VPN",
  abstract_ip_tor: "Tor",
  abstract_ip_hosting: "Hosting",
  abstract_ip_relay: "Relay",
  abstract_ip_abuse: "Abusive IP",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function networkRiskLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels = new Set<string>();

  for (const rawSignal of value) {
    const signal = record(rawSignal);
    if (typeof signal?.key === "string" && SIGNAL_LABELS[signal.key]) {
      labels.add(SIGNAL_LABELS[signal.key]);
      continue;
    }
    if (signal?.key !== "proxycheck_anonymous") continue;
    const payload = record(signal.payload);
    const detectionTypes = Array.isArray(payload?.detectionTypes)
      ? payload.detectionTypes
      : typeof payload?.type === "string"
        ? payload.type.split(",")
        : [];

    for (const detection of detectionTypes) {
      if (typeof detection !== "string") continue;
      const key = detection.trim().toLowerCase();
      if (key) labels.add(NETWORK_LABELS[key] ?? key.replaceAll("_", " "));
    }
    if (labels.size === 0) labels.add("Anonymous IP");
  }

  return [...labels];
}

export function NetworkRiskBadges({ signals }: { signals: unknown }) {
  const labels = networkRiskLabels(signals);
  if (labels.length === 0) return null;

  return (
    <>
      {labels.map((label) => (
        <span
          key={label}
          className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-600 dark:text-rose-300"
        >
          <ShieldAlert className="size-2.5" aria-hidden />
          {label}
        </span>
      ))}
    </>
  );
}
