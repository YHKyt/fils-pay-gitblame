package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Regression: Delta Marketplace split payouts were a few fils short every
// batch because each child share was rounded on its own. Non-round splits must
// still sum to the net payout exactly, and no share may go negative.
func TestChildShares_ExactOnNonRoundSplits(t *testing.T) {
	cases := []struct {
		net     money.Fils
		weights []int64
	}{
		{1001, []int64{3333, 3333, 3334}},
		{100, []int64{3333, 3333, 3334}},
		{999_999, []int64{3333, 3333, 3334}},
		{7, []int64{2500, 2500, 2500, 2500}},
		{123_457, []int64{1000, 2000, 3000, 4000}},
	}
	for _, tc := range cases {
		ws := make([]ChildWeight, len(tc.weights))
		for i, w := range tc.weights {
			ws[i] = ChildWeight{WeightBps: w}
		}
		var sum money.Fils
		for _, s := range ChildShares(tc.net, ws) {
			if s < 0 {
				t.Fatalf("negative share for net %d", tc.net)
			}
			sum += s
		}
		if sum != tc.net {
			t.Errorf("net %d weights %v: shares sum to %d, want %d", tc.net, tc.weights, sum, tc.net)
		}
	}
}

func TestChildShares_PartialWeightsLeaveParentRemainder(t *testing.T) {
	// weights sum to 6000 bps: children get 60% of 1000 = 600 exactly.
	ws := []ChildWeight{{WeightBps: 3000}, {WeightBps: 3000}}
	got := ChildShares(1000, ws)
	if got[0]+got[1] != 600 {
		t.Fatalf("children got %d, want 600", got[0]+got[1])
	}
}
