package settlement

import (
	"errors"
	"fmt"
	"time"
)

// ErrBusinessDayNotOver is returned by RequireBusinessDayOver for a business
// date whose Asia/Bahrain day has not finished yet (today, or any later date).
var ErrBusinessDayNotOver = errors.New("settlement: business day has not ended yet")

// RequireBusinessDayOver refuses a business date whose Asia/Bahrain window
// ends after now. CloseBatch only ever selects the events inside that one
// window and a closed batch is never re-scanned, so closing a day while it
// is still running would strand every capture that happens later that day:
// no future batch would ever pick it up. Every manual entrypoint (the
// run-batch CLI and the internal API) checks this before RunDailyBatch.
func RequireBusinessDayOver(businessDate, now time.Time) error {
	_, end := BusinessDayWindow(businessDate)
	if end.After(now) {
		return fmt.Errorf("%w: %s ends at %s", ErrBusinessDayNotOver,
			businessDate.Format("2006-01-02"), end.In(businessDayLocation).Format(time.RFC3339))
	}
	return nil
}
