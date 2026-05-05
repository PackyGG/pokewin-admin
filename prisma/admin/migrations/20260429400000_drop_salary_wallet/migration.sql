-- Drop the salary_wallet table — auto-payment system removed,
-- motha now sends USDT manually from their own wallet via QR
-- code scan. The salary_employees + salary_payouts tables stay;
-- payouts is repurposed as a manual log.
DROP TABLE IF EXISTS "salary_wallet";
