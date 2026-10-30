package money

import "testing"

// ApplyRateFils multiplied amount*rateBasisPoints in int64. Go does not trap
// overflow, so above ~9.2e18 the product wrapped and the "fee" came back
// negative, while packages/money (bigint intermediates) returns the exact
// value for the same input. Values here are the TypeScript results.
func TestApplyRateFils_NoOverflowMatchesTS(t *testing.T) {
	cases := []struct {
		amount Fils
		bps    int64
		want   Fils
	}{
		{922_337_203_685_478, 10000, 922_337_203_685_478},
		{1_000_000_000_000_000, 9999, 999_900_000_000_000},
		{1_000_000_000_000_000, 10000, 1_000_000_000_000_000},
		{9_007_199_254_740_991, 3333, 3_002_099_511_605_172},
		{9_007_199_254_740_991, 5000, 4_503_599_627_370_496}, // exact tie -> even
		{9_007_199_254_740_991, 10000, 9_007_199_254_740_991},
		{-9_007_199_254_740_991, 5000, -4_503_599_627_370_496},
		// Ordinary values keep the existing half-even results.
		{4740, 250, 118},
		{4750, 250, 119},
		{602, 275, 17},
		{100, 50, 0},
	}
	for _, c := range cases {
		if got := ApplyRateFils(c.amount, c.bps); got != c.want {
			t.Errorf("ApplyRateFils(%d, %d) = %d, want %d", c.amount, c.bps, got, c.want)
		}
	}
}
