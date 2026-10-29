package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// Regression: NetPayableFils went through float32 BD and lost fils on large
// batches. It must be exact integer subtraction at any size.
func TestNetPayableFils_ExactForLargeBatches(t *testing.T) {
	cases := []struct{ gross, fee, want money.Fils }{
		{36_275_242, 906_881, 35_368_361},
		{12_345_678, 308_641, 12_037_037},
		{99_999_999_999, 2_499_999_999, 97_500_000_000},
		{13_333, 333, 13_000},
		{0, 0, 0},
	}
	for _, tc := range cases {
		if got := NetPayableFils(tc.gross, tc.fee); got != tc.want {
			t.Errorf("NetPayableFils(%d, %d) = %d, want %d", tc.gross, tc.fee, got, tc.want)
		}
	}
}
