package settlement

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A scheme_export_lines row without the 0050 `amount` column filled in
// (written before 0050, or by any writer that only sets amount_fils) falls
// back to amount_fils / 1000. That division is unscaled numeric, so 93270
// fils was exported as "93.2700000000000000" and 5000 fils as
// "5.0000000000000000" instead of the two-decimal figure the scheme takes.
func TestExportSchemeFileFallbackAmountHasTwoDecimals(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	batchID := insertBatch(t, pool, merchantID, time.Date(2026, 3, 11, 0, 0, 0, 0, time.UTC), "closed", 0)
	day, _ := BusinessDayWindow(time.Date(2026, 3, 11, 0, 0, 0, 0, time.UTC))

	for i, amountFils := range []int64{93270, 5000} {
		txnID, _ := insertCaptureEvent(t, pool, merchantID, 250, 10000, day.Add(time.Hour))
		if _, err := pool.Exec(ctx, `
			INSERT INTO scheme_export_lines (settlement_batch_id, transaction_id, amount_fils, line_sequence)
			VALUES ($1, $2, $3, $4)
		`, batchID, txnID, amountFils, i+1); err != nil {
			t.Fatalf("insert legacy line: %v", err)
		}
	}

	lines, err := LoadSchemeExportLines(ctx, pool, batchID)
	if err != nil {
		t.Fatalf("LoadSchemeExportLines: %v", err)
	}
	want := []string{"93.27", "5.00"}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d", len(lines), len(want))
	}
	for i, line := range lines {
		if line.Amount != want[i] {
			t.Errorf("line %d amount = %q, want %q", line.LineSequence, line.Amount, want[i])
		}
	}

	out := filepath.Join(t.TempDir(), "batch.csv")
	if _, err := ExportSchemeFile(ctx, pool, batchID, out); err != nil {
		t.Fatalf("ExportSchemeFile: %v", err)
	}
	got, _ := os.ReadFile(out)
	for _, w := range want {
		if !containsField(string(got), w) {
			t.Errorf("file does not carry amount %q:\n%s", w, got)
		}
	}
}

func containsField(file, field string) bool {
	for _, line := range strings.Split(file, "\n") {
		for _, f := range strings.Split(line, ",") {
			if f == field {
				return true
			}
		}
	}
	return false
}
