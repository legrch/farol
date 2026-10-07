package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestArchivedInspectionPureFullChainAndEarlyCorruption(t *testing.T) {
	for _, kind := range []string{"valid", "early-attempt", "early-commit", "early-record-recommitted", "gap", "selected-head", "selected-binding"} {
		t.Run(kind, func(t *testing.T) {
			d := &memoryDisk{}
			r := recordFixture()
			a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
			a = historyCycle(t, d, historyRecord(a.Consumption.NextBinding, "second"), historyNextBinding(a.Consumption.NextBinding, 3))
			records := make([]ArchivedRecord, len(d.records))
			for n, raw := range d.records {
				sum := sha256.Sum256(raw)
				records[n] = ArchivedRecord{append([]byte(nil), raw...), hex.EncodeToString(sum[:])}
			}
			selected, head := a.Consumption.NextBinding, a.HeadDigest
			switch kind {
			case "early-attempt":
				records[0].Attempt[0] = '!'
			case "early-commit":
				records[0].Commit = "changed"
			case "early-record-recommitted":
				records[0].Attempt = []byte("{}")
				sum := sha256.Sum256(records[0].Attempt)
				records[0].Commit = hex.EncodeToString(sum[:])
			case "gap":
				records = append(records[:1], records[2:]...)
			case "selected-head":
				head[0]++
			case "selected-binding":
				selected.HostLifetimeID = "crossed"
			}
			err := ValidateArchivedEmptyRecords(context.Background(), repoFixture(d).owner.roots, selected, head, records)
			if (kind == "valid") != (err == nil) || d.fenced || d.calls != 0 {
				t.Fatal(kind, err, "native writer used")
			}
		})
	}
}
