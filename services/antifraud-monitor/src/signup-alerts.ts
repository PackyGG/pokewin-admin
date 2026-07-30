import type { Signal } from "./types.js";

export const HIGH_RISK_SIGNUP_SCORE = 50;

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
