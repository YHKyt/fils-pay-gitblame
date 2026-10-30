// Package scheduler — status.go. Lightweight operational logging only:
// estimates, for an operator tailing the daemon's logs, roughly when the
// next check-in will happen. This is informational — it has no bearing
// on runIfDue's actual decision (settlement.BusinessDayWindow, in
// internal/settlement/window.go, remains the sole authority on whether a
// business day has completed) — added purely so the daemon's own log
// output says something more useful than "checked, nothing due yet" on
// every tick.
package scheduler

import (
	"log"
	"os"
	"time"
)

// schedulingLocation is the zone this log estimate renders in. Reads the
// process's TZ setting (the same convention every other timestamp this
// service logs already follows via Go's default time formatting), falling
// back to the container's local zone when TZ is unset — kept independent
// of internal/settlement's own businessDayLocation, which is a private
// var of that package and not reachable from here.
// FH: reads TZ, container has TZ unset, so these log lines say UTC. confusing but log-only
// MK: DO NOT use this for anything but logs.
func schedulingLocation() *time.Location {
	if tz := os.Getenv("TZ"); tz != "" {
		if loc, err := time.LoadLocation(tz); err == nil {
			return loc
		}
	}
	return time.Local
}

// estimateNextRunAt is the daemon's next check-in, in schedulingLocation():
// its ticker fires every poll interval, so one interval after the wake that
// just ran (lastCheckedAt is that wake's tick). It used to be the last
// check-in plus 24 hours, which was neither the next check nor the next
// close. It is never consulted by runIfDue.
func estimateNextRunAt(lastCheckedAt time.Time, pollInterval time.Duration) time.Time {
	return lastCheckedAt.Add(pollInterval).In(schedulingLocation())
}

// logNextRunEstimate writes the next check-in to the daemon's log after
// each wake.
func logNextRunEstimate(lastCheckedAt time.Time, pollInterval time.Duration) {
	log.Printf("settlement daemon: next check-in ~%s", estimateNextRunAt(lastCheckedAt, pollInterval).Format(time.RFC3339))
}
