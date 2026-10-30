package settlement

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/google/uuid"
)

// TestExportSchemeFileRefusesBatchWithoutFrozenLines pins that
// `settlement export-scheme-file` only writes a file for a batch whose
// scheme lines have been frozen (status 'closed' or 'paid'). An open batch
// has no lines yet and an unknown id has none at all; exporting either used
// to write an empty file and report "wrote 0 line(s)" with exit code 0,
// which an operator could send to the scheme as that day's file (and which
// silently replaced a good file already at --out).
func TestExportSchemeFileRefusesBatchWithoutFrozenLines(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	openBatch := insertBatch(t, pool, merchantID, time.Date(2026, 3, 9, 0, 0, 0, 0, time.UTC), "open", 0)

	for name, batchID := range map[string]uuid.UUID{"open batch": openBatch, "unknown batch": uuid.New()} {
		t.Run(name, func(t *testing.T) {
			out := filepath.Join(t.TempDir(), "batch.csv")
			if err := os.WriteFile(out, []byte("previous good file\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			n, err := ExportSchemeFile(ctx, pool, batchID, out)
			if err == nil {
				t.Fatalf("ExportSchemeFile(%s) = %d line(s), nil error; want an error", name, n)
			}
			got, _ := os.ReadFile(out)
			if string(got) != "previous good file\n" {
				t.Fatalf("existing --out file was overwritten with %q", got)
			}
		})
	}

	// A closed batch with zero captures is a legitimate empty file.
	closed := insertBatch(t, pool, merchantID, time.Date(2026, 3, 10, 0, 0, 0, 0, time.UTC), "closed", 0)
	if n, err := ExportSchemeFile(ctx, pool, closed, filepath.Join(t.TempDir(), "empty.csv")); err != nil || n != 0 {
		t.Fatalf("closed empty batch: got (%d, %v), want (0, nil)", n, err)
	}
}
