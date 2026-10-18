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
		wire := fmt.Sprintf(`{"schema":1,"pid":42,"startedAt":"2026-10-18T00:00:00.000Z","bootTime":%s,"processStart":"birth"}`, boot)
		if at, err := liveMarker([]byte(wire), 42, "birth"); err != nil || at != "2026-10-18T00:00:00.000Z" {
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

// Match the actual current RunMarkerSchema values. This validates record shape,
// not process identity, authoritative lease custody or a trusted clock source.
func TestLiveRecordDeterministicProducerSchema(t *testing.T) {
	wire := func(at, boot string) []byte {
		return []byte(fmt.Sprintf(`{"schema":1,"pid":42,"startedAt":%q,"bootTime":%s,"processStart":"birth"}`, at, boot))
	}
	for _, boot := range []string{`{}`, `[]`, `true`, `"0"`, `-1`, `0.25`, `9007199254740992`, `1e20`} {
		if _, err := liveMarker(wire("2026-10-18T00:00:00.000Z", boot), 42, "birth"); err != errRunMarkerMismatch {
			t.Error("malformed producer boot time accepted", boot, err)
		}
	}
	for _, at := range []string{"2026-10-18T00:00:00Z", "2026-10-18T00:00:00.00Z", "2026-10-18T00:00:00.0000Z", "2026-10-18T00:00:00.000+00:00", "2026-02-30T00:00:00.000Z"} {
		if _, err := liveMarker(wire(at, "null"), 42, "birth"); err != errRunMarkerMismatch {
			t.Error("noncanonical producer timestamp accepted", at, err)
		}
	}
	for _, boot := range []string{"null", "0", "-0", "0.0", "1e3", "1792000000000", "9007199254740991"} {
		if at, err := liveMarker(wire("2026-10-18T00:00:00.000Z", boot), 42, "birth"); err != nil || at != "2026-10-18T00:00:00.000Z" {
			t.Error("valid producer values refused", boot, err)
		}
	}
}
