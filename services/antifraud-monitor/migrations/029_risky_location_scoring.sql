INSERT INTO score_weights(key, points)
VALUES ('risky_location', 40)
ON CONFLICT (key) DO NOTHING;
