export type StoredDecisionIdentity = {
  case_id: string;
  action_type: string;
  actor_id: string;
  actor_username: string | null;
  reason: string | null;
};

export type RequestedDecisionIdentity = {
  caseId: string;
  decision: string;
  actorId: string;
  actorUsername: string | null;
  reason: string;
};

export function sameDecisionIdentity(
  stored: StoredDecisionIdentity,
  requested: RequestedDecisionIdentity,
): boolean {
  return (
    stored.case_id === requested.caseId &&
    stored.action_type === requested.decision &&
    stored.actor_id === requested.actorId &&
    stored.actor_username === requested.actorUsername &&
    stored.reason === requested.reason
  );
}
