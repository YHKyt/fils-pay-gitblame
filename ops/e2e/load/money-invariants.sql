-- Money invariants after a load or crash test (docs/audit/hostharden.md).
-- psql -At -F' ' < ops/e2e/load/money-invariants.sql   (every row but the
-- "reserved", "in_doubt", "authorized_only" and "total" counts must be 0)
\pset footer off
SELECT 'unbalanced_ledger_groups' AS check, count(*) AS n FROM (
  SELECT entry_group_id FROM ledger_entries GROUP BY entry_group_id
  HAVING SUM(CASE WHEN direction='debit' THEN amount_fils ELSE 0 END)
      <> SUM(CASE WHEN direction='credit' THEN amount_fils ELSE 0 END)) x
UNION ALL
SELECT 'paid_link_without_matching_capture (excl. in-doubt)', count(*) FROM payment_links pl
  LEFT JOIN transactions t ON t.id = pl.transaction_id
  WHERE pl.status = 'paid' AND (t.id IS NULL OR (t.status NOT IN ('captured','partially_refunded','refunded','authorized')) OR (t.status <> 'authorized' AND t.captured_fils <> pl.amount_fils))
UNION ALL
SELECT 'in_doubt_paid_link_tx_authorized (public status processing)', count(*) FROM payment_links pl JOIN transactions t ON t.id = pl.transaction_id
  WHERE pl.status = 'paid' AND t.status = 'authorized'
UNION ALL
SELECT 'link_with_two_captures', count(*) FROM (
  SELECT pl.id FROM payment_links pl JOIN transactions t ON t.reference = pl.reference AND t.merchant_id = pl.merchant_id
  WHERE t.status IN ('captured','partially_refunded','refunded') GROUP BY pl.id HAVING count(*) > 1) x
UNION ALL
SELECT 'captured_tx_without_ledger', count(*) FROM transactions t
  WHERE t.captured_fils > 0 AND NOT EXISTS (SELECT 1 FROM ledger_entries le WHERE le.transaction_id = t.id)
UNION ALL
SELECT 'refunded_more_than_captured', count(*) FROM transactions WHERE refunded_fils > captured_fils
UNION ALL
SELECT 'links_reserved_now', count(*) FROM payment_links WHERE status = 'reserved'
UNION ALL
SELECT 'links_reserved_past_lease', count(*) FROM payment_links WHERE status = 'reserved' AND reserved_at < now() - interval '60 seconds'
UNION ALL
SELECT 'transactions_authorized_only', count(*) FROM transactions WHERE status = 'authorized' AND created_at > now() - interval '1 day'
UNION ALL
SELECT 'payment_links_paid_total', count(*) FROM payment_links WHERE status = 'paid';
