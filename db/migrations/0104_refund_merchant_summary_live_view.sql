-- refund_merchant_summary is a MATERIALIZED view (0072, recreated by 0075)
-- whose header says it is "refreshed by the reporting worker after each
-- settlement run". Nothing in the repository ever runs
-- REFRESH MATERIALIZED VIEW refund_merchant_summary, so the view holds
-- exactly the rows that existed when 0075 ran (none on a fresh database) and
-- never shows a refund made after the deploy.
--
-- At this table's size a plain view is cheap, and it is always current, so
-- there is no refresh to forget. Same columns, same query as 0075.

DROP MATERIALIZED VIEW IF EXISTS refund_merchant_summary;

CREATE VIEW refund_merchant_summary AS
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
