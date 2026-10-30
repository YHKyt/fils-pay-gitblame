-- Authorization idempotency rows written before the card-hash fix (0c34a1e,
-- api-security-and-refunds S9) hold
--   request_hash = sha256(canonicalJson({ amountFils, card, reference }))
-- with the whole card in it, CVV included, and no key. The amount and
-- reference are on the transactions row, so with the PAN the CVV is one of
-- 1,000 sha256 guesses, and the PAN itself is a small search. PCI DSS forbids
-- keeping the CVV in any form after authorization. The code fix only changed
-- what new rows store, so the old rows still carried the card.
--
-- The old and the new hash are both 64 hex characters, so the two cannot be
-- told apart in SQL, and the database does not hold the HMAC key needed to
-- recompute a new-style hash (that would also need the card). Every
-- transactions.authorize row is therefore overwritten with a constant that no
-- request can hash to:
--   * a row from before the fix could never match a new request anyway (its
--     hash covered the raw card), so nothing is lost for it;
--   * a row written after the fix loses its replay: a same-key retry that
--     spans this migration gets 422 idempotency_key_reused instead of the
--     stored response. That is the same one-off effect the code fix itself
--     had at deploy, and a client retry window is minutes, not days.
-- resource_id, status and response_body are untouched, so the payment-link
-- checks that read resource_id (paymentLinks/pay.ts) keep working.
--
-- No other endpoint hashes card data (capture, refunds and the admin
-- actions hash ids, amounts and reasons only), so only authorize rows change.
-- Re-running this is a no-op.
UPDATE idempotency_keys
   SET request_hash = 'redacted:pre-0124'
 WHERE endpoint = 'transactions.authorize'
   AND request_hash <> 'redacted:pre-0124';
