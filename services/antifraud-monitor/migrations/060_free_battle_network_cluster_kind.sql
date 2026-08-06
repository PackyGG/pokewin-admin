-- The free-battle-risk relationship cross-link (network-cluster evidence) writes
-- creator_risk_kind = 'network_cluster', which the original CHECK constraints on
-- free_battle_risk_matches and free_battle_creator_cursors do not allow, causing
-- every free-battle-risk poll tick to fail in production.

ALTER TABLE free_battle_risk_matches
  DROP CONSTRAINT free_battle_risk_matches_creator_risk_kind_check;

ALTER TABLE free_battle_risk_matches
  ADD CONSTRAINT free_battle_risk_matches_creator_risk_kind_check
  CHECK (creator_risk_kind IN (
    'kyc_rejected',
    'fraud_kyc_required',
    'suspected_alt',
    'antifraud_flagged',
    'network_cluster'
  ));

ALTER TABLE free_battle_creator_cursors
  DROP CONSTRAINT free_battle_creator_cursors_creator_risk_kind_check;

ALTER TABLE free_battle_creator_cursors
  ADD CONSTRAINT free_battle_creator_cursors_creator_risk_kind_check
  CHECK (creator_risk_kind IN (
    'kyc_rejected',
    'fraud_kyc_required',
    'suspected_alt',
    'antifraud_flagged',
    'network_cluster'
  ));
