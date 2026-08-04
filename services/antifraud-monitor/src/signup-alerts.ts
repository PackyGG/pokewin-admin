import type { Signal } from "./types.js";

export const LOW_RISK_SIGNUP_SCORE = 21;
export const HIGH_RISK_SIGNUP_SCORE = 50;

export function signupDiscordAlertKind(
  score: number,
): "low_risk" | "high_risk" | null {
  if (score >= HIGH_RISK_SIGNUP_SCORE) return "high_risk";
  if (score >= LOW_RISK_SIGNUP_SCORE) return "low_risk";
  return null;
}

export function highRiskSignupMarker(input: {
  userId: string;
  caseId: string;
  score: number;
  signals: Signal[];
}): {
  eventType: "high_risk_signup";
  source: "signup_alert";
  sourceRef: string;
  title: string;
  detail: string;
  payload: {
    monitorCaseId: string;
    signals: Array<{
      key: string;
      title: string;
      detail: string;
      points: number;
    }>;
  };
} {
  return {
    eventType: "high_risk_signup",
    source: "signup_alert",
    sourceRef: `${input.userId}:high_risk_signup`,
    title: "High-risk signup",
    detail: `Signup scored ${input.score} points and needs account review.`,
    payload: {
      monitorCaseId: input.caseId,
      signals: input.signals.map((signal) => ({
        key: signal.key,
        title: signal.title,
        detail: signal.detail,
        points: signal.points,
      })),
    },
  };
}
