package handoff

import (
	"fmt"
	"testing"
)

// Pure bounded parser regression; this test performs no native observation.
func TestLiveRecordDeterministicStrictFields(t *testing.T) {
	for _, data := range []string{`{"schema":1,"schema":1}`, `{"private":"\ud800"}`, `[]`, `{"pid":1} true`, `{"pid":1,"pid":2}`} {
		if _, err := recordFields([]byte(data)); err == nil {
			t.Fatal("ambiguous record accepted", data)
		}
	}
	fields, err := recordFields([]byte(`{"schema":1,"pid":2,"startedAt":"2026-10-18T00:00:00Z","bootTime":"fixture","processStart":"birth"}`))
	if err != nil || len(fields) != 5 {
		t.Fatal(fields, err)
	}
}

func TestLiveRecordDeterministicOriginalMarker(t *testing.T) {
	for _, boot := range []string{"null", "0", "1792000000000"} {
		wire := fmt.Sprintf(`{"schema":1,"pid":42,"startedAt":"2026-10-18T00:00:00Z","bootTime":%s,"processStart":"birth"}`, boot)
		if at, err := liveMarker([]byte(wire), 42, "birth"); err != nil || at != "2026-10-18T00:00:00Z" {
			t.Fatal("original producer refused", wire, err)
		}
		if _, err := liveMarker([]byte(wire), 43, "birth"); err != errRunMarkerMismatch {
			t.Fatal("crossed process refusal changed", err)
		}
		if _, err := liveMarker([]byte(wire), 42, "other"); err != errRunMarkerMismatch {
			t.Fatal("crossed birth refusal changed", err)
		}
	}
}
