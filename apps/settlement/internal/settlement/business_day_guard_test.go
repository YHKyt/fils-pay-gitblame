package settlement

import (
	"errors"
	"testing"
	"time"
)

// A business date may only be closed once its Asia/Bahrain day is over.
func TestRequireBusinessDayOver(t *testing.T) {
	bh := BusinessLocation()
	date := func(s string) time.Time {
		d, err := time.Parse("2006-01-02", s)
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	cases := []struct {
		name string
		date string
		now  time.Time
		ok   bool
	}{
		{"today at 13:00 is refused", "2026-10-29", time.Date(2026, 10, 29, 13, 0, 0, 0, bh), false},
		{"tomorrow is refused", "2026-10-30", time.Date(2026, 10, 29, 13, 0, 0, 0, bh), false},
		{"yesterday is allowed", "2026-10-28", time.Date(2026, 10, 29, 13, 0, 0, 0, bh), true},
		{"one ns before Bahrain midnight is refused", "2026-10-28", time.Date(2026, 10, 29, 0, 0, 0, 0, bh).Add(-1), false},
		{"exactly Bahrain midnight is allowed", "2026-10-28", time.Date(2026, 10, 29, 0, 0, 0, 0, bh), true},
		// 22:00 UTC on the 28th is 01:00 on the 29th in Bahrain: the 28th is
		// over even though its UTC day is not.
		{"Bahrain day over before UTC day", "2026-10-28", time.Date(2026, 10, 28, 22, 0, 0, 0, time.UTC), true},
		{"Bahrain today while UTC still yesterday", "2026-10-29", time.Date(2026, 10, 28, 22, 0, 0, 0, time.UTC), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := RequireBusinessDayOver(date(tc.date), tc.now)
			if tc.ok && err != nil {
				t.Fatalf("got %v, want nil", err)
			}
			if !tc.ok && !errors.Is(err, ErrBusinessDayNotOver) {
				t.Fatalf("got %v, want ErrBusinessDayNotOver", err)
			}
		})
	}
}
