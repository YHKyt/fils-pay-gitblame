package scheduler

import (
	"testing"
	"time"
)

func TestEstimateNextRunAt(t *testing.T) {
	t.Setenv("TZ", "UTC")

	// The next check-in is one poll interval after the last one, not a day.
	lastCheckedAt := time.Date(2026, 5, 14, 21, 15, 0, 0, time.UTC)
	got := estimateNextRunAt(lastCheckedAt, 60*time.Second)
	want := time.Date(2026, 5, 14, 21, 16, 0, 0, time.UTC)

	if !got.Equal(want) {
		t.Fatalf("estimateNextRunAt(%s) = %s, want %s", lastCheckedAt.Format(time.RFC3339), got.Format(time.RFC3339), want.Format(time.RFC3339))
	}
}

func TestSchedulingLocationUsesTZ(t *testing.T) {
	t.Setenv("TZ", "UTC")

	if got := schedulingLocation().String(); got != "UTC" {
		t.Fatalf("schedulingLocation() = %q, want %q", got, "UTC")
	}
}
