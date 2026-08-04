import type { Signal } from "./types.js";

export const LOW_RISK_SIGNUP_SCORE = 21;
export const HIGH_RISK_SIGNUP_SCORE = 50;
export const CRITICAL_RISK_SIGNUP_SCORE = 70;

export type SignupDiscordAlertKind =
  | "low_risk"
  | "high_risk"
  | "critical_risk";

export function signupDiscordAlertKind(
  score: number,
): SignupDiscordAlertKind | null {
  if (score >= CRITICAL_RISK_SIGNUP_SCORE) return "critical_risk";
  if (score >= HIGH_RISK_SIGNUP_SCORE) return "high_risk";
  if (score >= LOW_RISK_SIGNUP_SCORE) return "low_risk";
  return null;
}

export function signupMonitorDurationSeconds(score: number): number {
  if (score >= CRITICAL_RISK_SIGNUP_SCORE) return 15 * 60;
  if (score >= HIGH_RISK_SIGNUP_SCORE) return 10 * 60;
  if (score >= LOW_RISK_SIGNUP_SCORE) return 5 * 60;
  return 0;
}

export function signupReviewMarker(input: {
  userId: string;
  caseId: string;
  score: number;
  signals: Signal[];
}): {
  eventType: "high_risk_signup" | "critical_risk_signup";
  source: "signup_alert";
  sourceRef: string;
  title: string;
  detail: string;
  payload: {
    monitorCaseId: string;
    riskBand: "high" | "critical";
    containmentRequired: boolean;
    reasonCode?: "critical_signup_score";
    actions?: Array<"lock_fiat_deposits" | "lock_withdrawals" | "lock_tips">;
    signals: Array<{
      key: string;
      title: string;
      detail: string;
      points: number;
    }>;
  };
} {
  const critical = input.score >= CRITICAL_RISK_SIGNUP_SCORE;
  const eventType = critical ? "critical_risk_signup" : "high_risk_signup";
  return {
    eventType,
    source: "signup_alert",
    sourceRef: `${input.userId}:${eventType}`,
    title: critical ? "Critical-risk signup" : "High-risk signup",
    detail: critical
      ? `Signup scored ${input.score} points. Fiat deposits, withdrawals, and tips must be locked while staff review the account.`
      : `Signup scored ${input.score} points and needs account review.`,
    payload: {
      monitorCaseId: input.caseId,
      riskBand: critical ? "critical" : "high",
      containmentRequired: critical,
      ...(critical
        ? {
            reasonCode: "critical_signup_score" as const,
            actions: [
              "lock_fiat_deposits" as const,
              "lock_withdrawals" as const,
              "lock_tips" as const,
            ],
          }
        : {}),
      signals: input.signals.map((signal) => ({
        key: signal.key,
        title: signal.title,
        detail: signal.detail,
        points: signal.points,
      })),
    },
  };
}
