package settlement

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/filspay/settlement/internal/money"
)

// UpdateLifetimePayoutMonitoringEstimate maintains the ops dashboard
// running payout total on the merchant row. Not payout-affecting.
func UpdateLifetimePayoutMonitoringEstimate(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID, netPayoutFils money.Fils) error {
	_, err := tx.Exec(ctx, `
		UPDATE merchants
		   SET lifetime_net_payout_monitoring_estimate = lifetime_net_payout_monitoring_estimate + $2
		 WHERE id = $1
	`, merchantID, int64(netPayoutFils))
	// The column was REAL (32-bit float, 0040) and the delta was sent as
	// float32: ~7 significant digits, so once a merchant's running total
	// passed 2^24 fils (~16.7K BD) small payouts rounded away and the figure
	// drifted for high-volume merchants. 0074 makes it BIGINT; send exact
	// integer fils (ADR-0001).
	return err
}
// EstimateMonthlyPayout returns an approximate total payout for the
// given merchant over the last 30 calendar days, used by the ops
// dashboard to flag merchants whose settlement run is unusually large
// or small relative to their recent history. Like
// UpdateLifetimePayoutMonitoringEstimate, this is a monitoring-only
// figure that never feeds into any payout-affecting code path.
func EstimateMonthlyPayout(ctx context.Context, tx pgx.Tx, merchantID uuid.UUID) (float32, error) {
	rows, err := tx.Query(ctx, `
		SELECT net_payout_fils FROM settlement_batches
		 WHERE merchant_id = $1 AND status = 'paid' AND paid_at >= now() - interval '30 days'
		 ORDER BY paid_at DESC
	`, merchantID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	// Accumulate in exact integer fils; convert once for the display value.
	var total int64
	var count int
	for rows.Next() {
		var netFils int64
		if err := rows.Scan(&netFils); err != nil {
			return 0, err
		}
		total += netFils
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	return float32(total), nil
}
