package splits

import (
	"math/big"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Regression: ChildShares multiplied netPayout by each weight in int64. Above
// about 922 billion BD of net payout (9.22e14 fils) the product wraps, and the
// shares came out negative or wrong while the API (which allows any safe
// integer of fils) had accepted the amounts. Shares must stay exact and sum to
// the net payout for every net that fits in a JavaScript safe integer.
func TestChildShares_LargeNetDoesNotOverflow(t *testing.T) {
	nets := []money.Fils{
		1_000_000_000_000_000, // 1e15 fils
		2_000_000_000_000_001,
		9_007_199_254_740_991, // Number.MAX_SAFE_INTEGER
	}
	weights := []int64{3333, 3333, 3334}
	ws := make([]ChildWeight, len(weights))
	for i, w := range weights {
		ws[i] = ChildWeight{WeightBps: w}
	}
	for _, net := range nets {
		shares := ChildShares(net, ws)
		var sum money.Fils
		for i, s := range shares {
			// Each share is the floor of its exact share, or one fil more.
			exact := new(big.Int).Mul(big.NewInt(int64(net)), big.NewInt(weights[i]))
			floor := new(big.Int).Quo(exact, big.NewInt(10000)).Int64()
			if int64(s) != floor && int64(s) != floor+1 {
				t.Fatalf("net %d child %d: share %d, exact floor %d", net, i, s, floor)
			}
			sum += s
		}
		if sum != net {
			t.Fatalf("net %d: shares %v sum to %d", net, shares, sum)
		}
	}
}
