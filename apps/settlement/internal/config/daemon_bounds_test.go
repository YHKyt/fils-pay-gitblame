package config

import "testing"

// A non-positive poll interval made the daemon panic at boot
// (time.NewTicker: "non-positive interval for NewTicker"), and a run delay
// of a whole day or more pushed the due time past the next midnight on
// every wake, so the daemon ran forever without ever closing a business
// day. Both are now refused when the configuration is loaded.
func TestLoad_RejectsDaemonValuesThatStopTheDailyClose(t *testing.T) {
	cases := map[string]map[string]string{
		"poll interval 0":  {"SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS": "0"},
		"poll interval -5": {"SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS": "-5"},
		"run delay -1":     {"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES": "-1"},
		"run delay 1440":   {"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES": "1440"},
		"run delay 2000":   {"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES": "2000"},
	}
	for name, env := range cases {
		t.Run(name, func(t *testing.T) {
			t.Setenv("DATABASE_URL", "postgres://a/db")
			withEnv(t, env)
			if cfg, err := Load(); err == nil {
				t.Fatalf("Load accepted %v: poll=%s delay=%dm", env, cfg.DaemonPollInterval, cfg.DaemonRunDelayMinutes)
			}
		})
	}

	t.Run("bounds themselves are accepted", func(t *testing.T) {
		withEnv(t, map[string]string{
			"DATABASE_URL": "postgres://a/db",
			"SETTLEMENT_DAEMON_POLL_INTERVAL_SECONDS": "1",
			"SETTLEMENT_DAEMON_RUN_DELAY_MINUTES":     "0",
		})
		if _, err := Load(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		t.Setenv("SETTLEMENT_DAEMON_RUN_DELAY_MINUTES", "1439")
		if _, err := Load(); err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}
