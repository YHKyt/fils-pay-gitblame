package config

import "testing"

func withEnv(t *testing.T, kv map[string]string) {
	t.Helper()
	for k, v := range kv {
		t.Setenv(k, v)
	}
}

func TestLoad_DatabaseURLRequired(t *testing.T) {
	withEnv(t, map[string]string{"DATABASE_URL": "", "PGCONN_SETTLEMENT": ""})
	if _, err := Load(); err == nil {
		t.Fatal("expected an error when DATABASE_URL is unset")
	}
}

func TestLoad_UsesDatabaseURLByDefault(t *testing.T) {
	withEnv(t, map[string]string{"DATABASE_URL": "postgres://a/db", "PGCONN_SETTLEMENT": ""})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://a/db" {
		t.Fatalf("expected DatabaseURL to be DATABASE_URL's value, got %q", cfg.DatabaseURL)
	}
}

// Replaces TestLoad_PgconnSettlementOverridesWhenSet, which asserted the
// bug: PGCONN_SETTLEMENT (a replica / settlement role) beating DATABASE_URL
// for the worker's only pool, so every batch write went to the replica.
// ops/README.md: it only takes effect when DATABASE_URL is unset.
func TestLoad_DatabaseURLWinsOverPgconnSettlement(t *testing.T) {
	withEnv(t, map[string]string{
		"DATABASE_URL":      "postgres://a/db",
		"PGCONN_SETTLEMENT": "postgres://b/settlement-replica",
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://a/db" {
		t.Fatalf("expected DATABASE_URL to win over PGCONN_SETTLEMENT, got %q", cfg.DatabaseURL)
	}
}

func TestLoad_PgconnSettlementOnlyWhenDatabaseURLUnset(t *testing.T) {
	withEnv(t, map[string]string{
		"DATABASE_URL":      "",
		"PGCONN_SETTLEMENT": "postgres://b/settlement",
	})
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.DatabaseURL != "postgres://b/settlement" {
		t.Fatalf("expected the PGCONN_SETTLEMENT fallback when DATABASE_URL is unset, got %q", cfg.DatabaseURL)
	}
}
