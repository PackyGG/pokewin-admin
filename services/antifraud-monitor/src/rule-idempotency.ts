import { isDeepStrictEqual } from "node:util";

export type RuleUpdateIdentity = {
  targetId: string;
  actorId: string;
  actorUsername: string | null;
  changes: Record<string, unknown>;
};

export type StoredRuleUpdateIdentity = {
  action: string;
  target_id: string;
  actor_id: string;
  actor_username: string | null;
  request_state: RuleUpdateIdentity | null;
};

export function sameRuleUpdateIdentity(
  stored: StoredRuleUpdateIdentity,
  requested: RuleUpdateIdentity,
): boolean {
  return (
    stored.action === "rule.update" &&
    stored.target_id === requested.targetId &&
    stored.actor_id === requested.actorId &&
    stored.actor_username === requested.actorUsername &&
    stored.request_state !== null &&
    isDeepStrictEqual(stored.request_state, requested)
  );
}
