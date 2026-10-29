package settlement

import "testing"

// Regression: the lifetime platform counter was int32. Past 2,147,483,647 fils
// it wrapped negative and the 0.15% volume tier switched itself back off. With
// int64 the tier stays on for any realistic lifetime volume.
func TestVolumeTierMdrBonusBps_AboveInt32Max(t *testing.T) {
	for _, total := range []int64{2_147_483_647, 2_147_483_648, 5_000_000_000, 9_000_000_000_000} {
		if got := VolumeTierMdrBonusBps(total); got != 15 {
			t.Errorf("total %d: got %d bps, want 15", total, got)
		}
	}
}
