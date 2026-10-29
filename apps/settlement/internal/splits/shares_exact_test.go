package splits

import (
	"errors"
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

// This test used to assert that partial weights (6000 bps) "leave a parent
// remainder". That remainder is never paid out by any later batch, so a split
// must cover exactly 10000 bps; anything else is refused before payout.
func TestValidateWeights_RequiresExactly10000(t *testing.T) {
	cases := []struct {
		weights []int64
		ok      bool
	}{
		{[]int64{3000, 3000}, false},
		{[]int64{6000, 6000}, false},
		{[]int64{9999}, false},
		{nil, false},
		{[]int64{10000}, true},
		{[]int64{3333, 3333, 3334}, true},
	}
	for _, tc := range cases {
		ws := make([]ChildWeight, len(tc.weights))
		for i, w := range tc.weights {
			ws[i] = ChildWeight{WeightBps: w}
		}
		err := ValidateWeights(ws)
		if tc.ok && err != nil {
			t.Errorf("weights %v: got %v, want nil", tc.weights, err)
		}
		if !tc.ok && !errors.Is(err, ErrSplitWeightsNotWhole) {
			t.Errorf("weights %v: got %v, want ErrSplitWeightsNotWhole", tc.weights, err)
		}
	}
}
