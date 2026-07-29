CREATE TABLE IF NOT EXISTS kyc_country_reviews (
  user_id text NOT NULL,
  applicant_id text NOT NULL,
  account_country text,
  verified_country text,
  document_countries text[] NOT NULL DEFAULT '{}'::text[],
  country_match text NOT NULL
    CHECK (country_match IN ('match', 'mismatch', 'unknown')),
  review_status text,
  review_answer text,
  provider_reviewed_at timestamptz,
  checked_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, applicant_id)
);

CREATE INDEX IF NOT EXISTS kyc_country_reviews_mismatch_idx
  ON kyc_country_reviews (checked_at DESC)
  WHERE country_match = 'mismatch';
