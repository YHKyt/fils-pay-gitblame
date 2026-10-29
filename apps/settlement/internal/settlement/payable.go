package settlement

import (
	"github.com/filspay/settlement/internal/money"
)

// NetPayableFils derives the net payout from frozen gross and fee totals.
//
// Integer fils only (ADR-0001). This used to round-trip through float32 BD:
//
//	netBD := float32(grossFils)/1000 - float32(feeFils)/1000
//	return money.Fils(math.Round(float64(netBD) * 1000))
//
// float32 carries ~7 significant digits, so for any batch above ~10,000 BD the
// merchant's payout came out a few fils wrong (up to 6 fils at ~36,000 BD in a
// sweep of 10,000-60,000 BD batches, wrong in roughly two thirds of them), and
// the error grows with the batch. Net payable is simply gross minus fee.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
