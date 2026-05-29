-- Diagnostic SQL: coverage-based deposit attribution for one referred user
--
-- Run each block separately against the prod read replica to inspect
-- what the new admin-side PnL model does for a specific user.
--
-- Param: replace the referred_user_id literal at the top.

\set ref_uid 'xeyeujindiltavfvnnostjkhkrycggea'

-- ─── Block 1 ──────────────────────────────────────────────────────────
-- The user's acu activity timeline. Tells you which creator's code
-- they've ever touched, in what way (signup / deposit / wager), and
-- when. The "coverage windows" we use for attribution are the 7-day
-- spans starting at each acu.created_at.

SELECT acu.created_at,
       acu.usage_type,
       cu.username        AS creator_username,
       acu.affiliate_user_id AS creator_id,
       acu.code,
       acu.deposit_amount_usd::numeric AS deposit_usd,
       acu.wager_amount_usd::numeric   AS wager_usd,
       (acu.created_at + INTERVAL '7 days') AS coverage_ends_at
  FROM affiliate_code_usages acu
  JOIN "user" cu ON cu.id = acu.affiliate_user_id
 WHERE acu.referred_user_id = :'ref_uid'
 ORDER BY acu.created_at;


-- ─── Block 2 ──────────────────────────────────────────────────────────
-- Every ledger deposit by this user + the creator our coverage model
-- attributes it to. The "covering creator" column is the same logic
-- creators-pnl.ts uses:
--   most recent acu row by this user with
--     created_at IN [deposit_time - 7 days, deposit_time]
--   wins; their affiliate_user_id is the attributed creator.
--
-- `acu_already_recorded` shows whether the backend webhook
-- (fireblocks/webhook.service.ts) wrote an acu deposit row for this
-- ledger event. Per the `depositCount !== 1` early-return bug, this is
-- only true for the user's FIRST-EVER deposit.

WITH ledger_deps AS (
  SELECT lt.id,
         lt.user_id,
         lt.created_at,
         lt.amount::numeric AS amount_usd
    FROM ledger_transactions lt
   WHERE lt.user_id = :'ref_uid'
     AND lt.type   = 'deposit'
     AND lt.status = 'completed'
),
covered AS (
  SELECT d.*,
         (
           SELECT acu.affiliate_user_id
             FROM affiliate_code_usages acu
            WHERE acu.referred_user_id = d.user_id
              AND acu.created_at <= d.created_at
              AND acu.created_at >= d.created_at - INTERVAL '7 days'
            ORDER BY acu.created_at DESC
            LIMIT 1
         ) AS covering_creator_id,
         (
           SELECT acu.code
             FROM affiliate_code_usages acu
            WHERE acu.referred_user_id = d.user_id
              AND acu.created_at <= d.created_at
              AND acu.created_at >= d.created_at - INTERVAL '7 days'
            ORDER BY acu.created_at DESC
            LIMIT 1
         ) AS covering_code
    FROM ledger_deps d
)
SELECT c.created_at AS deposit_at,
       c.amount_usd,
       c.covering_creator_id,
       cu.username AS covering_creator_username,
       c.covering_code,
       EXISTS (
         SELECT 1
           FROM affiliate_code_usages acu_d
          WHERE acu_d.referred_user_id = c.user_id
            AND acu_d.usage_type = 'deposit'
            AND acu_d.created_at BETWEEN
                  c.created_at - INTERVAL '1 minute'
              AND c.created_at + INTERVAL '1 minute'
       ) AS acu_already_recorded
  FROM covered c
  LEFT JOIN "user" cu ON cu.id = c.covering_creator_id
 ORDER BY c.created_at;


-- ─── Block 3 ──────────────────────────────────────────────────────────
-- Per-creator deposit totals as the new admin-side model sees them.
-- Compare against the user's totals on the platform-level dashboard to
-- sanity-check the attribution.
--   • sum_under_coverage : the model's "this creator earned this much
--     deposit attribution from this user"
--   • acu_deposit_rows   : how many deposit rows the backend wrote for
--     this user under that creator (the buggy first-deposit-only count)

WITH covered AS (
  SELECT lt.amount::numeric AS amount_usd,
         (
           SELECT acu.affiliate_user_id
             FROM affiliate_code_usages acu
            WHERE acu.referred_user_id = lt.user_id
              AND acu.created_at <= lt.created_at
              AND acu.created_at >= lt.created_at - INTERVAL '7 days'
            ORDER BY acu.created_at DESC
            LIMIT 1
         ) AS covering_creator_id
    FROM ledger_transactions lt
   WHERE lt.user_id = :'ref_uid'
     AND lt.type   = 'deposit'
     AND lt.status = 'completed'
)
SELECT covered.covering_creator_id AS creator_id,
       cu.username                 AS creator_username,
       SUM(covered.amount_usd)::numeric(20,2)  AS sum_under_coverage,
       (
         SELECT COUNT(*)
           FROM affiliate_code_usages acu_d
          WHERE acu_d.referred_user_id = :'ref_uid'
            AND acu_d.usage_type = 'deposit'
            AND acu_d.affiliate_user_id = covered.covering_creator_id
       ) AS acu_deposit_rows,
       (
         SELECT COALESCE(SUM(acu_d.deposit_amount_usd::numeric), 0)
           FROM affiliate_code_usages acu_d
          WHERE acu_d.referred_user_id = :'ref_uid'
            AND acu_d.usage_type = 'deposit'
            AND acu_d.affiliate_user_id = covered.covering_creator_id
       )::numeric(20,2) AS sum_acu_deposit
  FROM covered
  LEFT JOIN "user" cu ON cu.id = covered.covering_creator_id
 WHERE covered.covering_creator_id IS NOT NULL
 GROUP BY covered.covering_creator_id, cu.username
 ORDER BY sum_under_coverage DESC;


-- ─── Block 4 ──────────────────────────────────────────────────────────
-- Card withdrawals by this user, restricted to cards from creator-
-- attributed sessions, plus the creator we'd book the withdrawal to.
--
-- Needs both:
--   • the card's source session was wagered under some creator's code
--     (`ui.source_id` matches an `acu` wager row)
--   • the user is "covered" by that creator at some deposit time
--     (= has at least one coverage-attributed deposit under them)

SELECT cwr.id AS cwr_id,
       COALESCE(cwr.shipped_at, cwr.completed_at) AS withdrawn_at,
       cwr.status,
       ui.id AS inventory_item_id,
       ui.value_at_obtained::numeric AS card_value_usd,
       ui.source_type,
       ui.source_id AS session_id,
       acu_w.affiliate_user_id AS session_creator_id,
       cu.username AS session_creator_username
  FROM card_withdrawal_requests cwr
  JOIN user_inventory ui ON ui.id = ANY(cwr.inventory_item_ids)
  LEFT JOIN affiliate_code_usages acu_w
         ON acu_w.game_session_id = ui.source_id
        AND acu_w.usage_type = 'wager'
  LEFT JOIN "user" cu ON cu.id = acu_w.affiliate_user_id
 WHERE ui.user_id = :'ref_uid'
   AND cwr.status IN ('completed', 'shipped')
   AND ui.source_type::text IN ('pack', 'battle')
 ORDER BY withdrawn_at;
