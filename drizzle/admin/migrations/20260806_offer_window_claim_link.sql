-- Creator VIP offer windows: name the claim that consumed each window.
--
-- WHY: `enforceOfferExpiry` re-issues an offer window with
-- `ON CONFLICT ... DO UPDATE SET claimed_at = NULL WHERE claimed_at IS NOT NULL`.
-- That is load-bearing — rejecting a claim releases its wager basis but never
-- clears `claimed_at`, so reject-then-reclaim only works if the window comes
-- back. The problem was WHICH windows it could bring back: the only thing
-- separating a rejected claim's window from an APPROVED, ALREADY PAID one was
-- that the recomputed `basis_position_usd` happened to land on a different
-- numeric(20,2) value. That is an incidental guard built on a float expression,
-- not a rule — and when it failed the same wager basis would be sold twice.
--
-- The link makes the rule explicit and checkable: a window is re-issuable only
-- when the claim it names is REJECTED. Nothing else can resurrect it.
--
-- SAFE TO ADD NOW: `creator_reward_offer_windows` is empty (0 rows, verified
-- against the admin DB 2026-08-06), so the NOT NULL-equivalent CHECK below
-- validates with nothing to backfill and no legacy rows to grandfather in.

ALTER TABLE creator_reward_offer_windows
  ADD COLUMN IF NOT EXISTS claim_id uuid;

-- RESTRICT, not SET NULL: a window that names a deleted claim would satisfy
-- neither state the CHECK below allows, and nothing in this codebase deletes a
-- claim (programs already carry ON DELETE RESTRICT from claims for the same
-- reason — paid-out history is not disposable).
DO $$ BEGIN
  ALTER TABLE creator_reward_offer_windows
    ADD CONSTRAINT creator_reward_offer_windows_claim_id_fkey
    FOREIGN KEY (claim_id) REFERENCES creator_reward_claims(id)
    ON UPDATE CASCADE ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Consumed and linked are the SAME fact, so they can never disagree: a claimed
-- window always names its claim, an open window never names one. This is what
-- turns "don't resurrect an approved claim's offer" from a convention into
-- something the database enforces.
ALTER TABLE creator_reward_offer_windows
  DROP CONSTRAINT IF EXISTS creator_reward_offer_windows_claim_link_chk;
ALTER TABLE creator_reward_offer_windows
  ADD CONSTRAINT creator_reward_offer_windows_claim_link_chk
  CHECK ((claimed_at IS NULL) = (claim_id IS NULL));

-- Answers "which windows did this claim consume" without a scan, and keeps the
-- RESTRICT check on the FK index-served.
CREATE INDEX IF NOT EXISTS creator_reward_offer_windows_claim_idx
  ON creator_reward_offer_windows (claim_id)
  WHERE claim_id IS NOT NULL;
