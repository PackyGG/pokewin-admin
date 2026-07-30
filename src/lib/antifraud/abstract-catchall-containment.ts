import type { AntifraudSignalEvent } from "@/lib/antifraud/ws";

export type AbstractCatchallContainmentTarget = {
  userId: string;
  domain: string;
  reason: string;
};

type AbstractCatchallContainmentDependencies = {
  lockAccount: (
    target: AbstractCatchallContainmentTarget,
  ) => Promise<boolean>;
  isKycRequired: (userId: string) => Promise<boolean>;
  requireKyc: (
    target: AbstractCatchallContainmentTarget,
  ) => Promise<void>;
};

function normalizedDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) &&
    domain.includes(".")
    ? domain
    : null;
}

export function abstractCatchallContainmentTarget(
  signal: AntifraudSignalEvent,
): AbstractCatchallContainmentTarget | null {
  const userId = signal.userId;
  const domain = normalizedDomain(signal.payload?.emailDomain);
  if (
    !userId
    || !domain
    || signal.payload?.containmentRequired !== true
    || signal.payload?.provider !== "abstract_email"
  ) {
    return null;
  }

  return {
    userId,
    domain,
    reason: (
      `Automatic fraud lock: signup used an Abstract-confirmed catch-all email domain (${domain})`
    ).slice(0, 500),
  };
}

export async function applyAbstractCatchallContainment(
  signal: AntifraudSignalEvent,
  dependencies: AbstractCatchallContainmentDependencies,
): Promise<"locked" | "skipped"> {
  const target = abstractCatchallContainmentTarget(signal);
  if (!target) return "skipped";
  if (!(await dependencies.lockAccount(target))) return "skipped";
  if (!(await dependencies.isKycRequired(target.userId))) {
    await dependencies.requireKyc(target);
  }
  return "locked";
}
