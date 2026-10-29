-- 0072 joined transactions ON t.id = r.id (a refund id is never a
-- transaction id), so original_captured_fils was always NULL. It also
-- summed captured_fils once per refund, double-counting a transaction with
-- several partial refunds. Recreate with the right join, counting each
-- transaction's capture once per day.

DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE MATERIALIZED VIEW refund_merchant_summary AS
WITH daily AS (
    SELECT r.merchant_id,
           r.transaction_id,
           date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain') AS business_date,
           COUNT(*)                 AS refund_count,
           SUM(r.amount_fils)       AS refunded_fils,
           SUM(r.fee_reversed_fils) AS fee_reversed_fils
      FROM refunds r
     WHERE r.status = 'succeeded'
     GROUP BY r.merchant_id, r.transaction_id, date_trunc('day', r.occurred_at AT TIME ZONE 'Asia/Bahrain')
)
SELECT d.merchant_id,
       d.business_date,
       SUM(d.refund_count)      AS refund_count,
       SUM(d.refunded_fils)     AS total_refunded_fils,
       SUM(d.fee_reversed_fils) AS total_fee_reversed_fils,
       SUM(t.captured_fils)     AS original_captured_fils
  FROM daily d
  JOIN transactions t ON t.id = d.transaction_id
 GROUP BY d.merchant_id, d.business_date;

CREATE UNIQUE INDEX idx_refund_merchant_summary_pk
    ON refund_merchant_summary (merchant_id, business_date);
