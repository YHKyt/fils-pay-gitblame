package settlement

import (
	"testing"
	"time"
)

// Regression for the daily-close timezone bug: the scheduler must read "now"
// in the business-day timezone so that an instant which is late evening in
// UTC but already past midnight in Bahrain is attributed to the Bahrain
// calendar day. 2026-10-28 21:30 UTC is 2026-10-29 00:30 Asia/Bahrain, so
// the business day it falls in starts at Bahrain midnight on the 29th.
func TestBusinessDayWindow_BahrainLocalInstant(t *testing.T) {
	loc := BusinessLocation()
	instant := time.Date(2026, 10, 28, 21, 30, 0, 0, time.UTC).In(loc)

	start, end := BusinessDayWindow(instant)

	wantStart := time.Date(2026, 10, 29, 0, 0, 0, 0, loc)
	if !start.Equal(wantStart) {
		t.Fatalf("start = %s, want Bahrain midnight %s", start, wantStart)
	}
	if end.Sub(start) != 24*time.Hour {
		t.Fatalf("window length = %s, want 24h", end.Sub(start))
	}
}

func TestBusinessLocation_IsBahrain(t *testing.T) {
	if got := BusinessLocation().String(); got != "Asia/Bahrain" {
		t.Fatalf("BusinessLocation() = %q, want Asia/Bahrain", got)
	}
}
