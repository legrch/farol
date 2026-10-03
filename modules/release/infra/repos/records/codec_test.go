package records

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	release "github.com/legrch/farol/modules/release/domain"
)

func acceptedOperation() Operation {
	return Operation{ID: strings.Repeat("e", 32), Source: Build{strings.Repeat("a", 64), "0.1.8-owner.beta.1", strings.Repeat("b", 64)}, Target: Build{strings.Repeat("c", 64), "0.1.9-owner.beta.1", strings.Repeat("d", 64)}}
}

func TestCurrentAlphaCorpus(t *testing.T) {
	// Independent symbolic records only. No private profile, native process,
	// physical package, persisted intent or installed acceptance is exercised.
	var cases []struct {
		Name  string
		Kind  string
		Value json.RawMessage
		Valid bool
	}
	data, err := os.ReadFile("testdata/alpha.json")
	if err != nil || json.Unmarshal(data, &cases) != nil {
		t.Fatalf("invalid corpus: %v", err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			var err error
			switch c.Kind {
			case "journal":
				_, err = DecodeJournal(c.Value, acceptedOperation())
			case "restore":
				_, err = DecodeRestore(c.Value, acceptedOperation())
			case "retained":
				_, err = DecodeRetained(c.Value)
			case "receipt":
				_, err = DecodeReceipt(c.Value)
			case "download":
				_, err = DecodeDownload(c.Value)
			case "rejected":
				_, err = DecodeRejectedTarget(c.Value, acceptedOperation())
			default:
				t.Fatalf("unknown fixture kind %s", c.Kind)
			}
			if (err == nil) != c.Valid {
				t.Fatalf("error=%v, expected valid=%v", err, c.Valid)
			}
		})
	}
}

func TestJournalRoundTripRetainsUnknownLaunch(t *testing.T) {
	j := Journal{Schema: "farol.installed-update-journal/1", Operation: acceptedOperation(), Phase: "launch_requested"}
	encoded, err := EncodeJournal(j)
	if err != nil || len(encoded) == 0 || encoded[len(encoded)-1] != '\n' {
		t.Fatalf("encode: %v", err)
	}
	decoded, err := DecodeJournal(encoded, j.Operation)
	if err != nil || *decoded != j {
		t.Fatalf("roundtrip: %+v, %v", decoded, err)
	}
	domain := decoded.Domain()
	source, target := domain.Operation.Source, domain.Operation.Target
	got := release.Assess(release.Observation{Operation: domain.Operation, Journal: &domain, Complete: true, Slot: &target, Previous: &source})
	if got.Kind != release.RollbackAvailable || got.Launch != release.LaunchUnknown {
		t.Fatalf("parsing inferred launch/process success: %+v", got)
	}
	crossed := j.Operation
	crossed.Source.Digest = strings.Repeat("f", 64)
	if _, err := DecodeJournal(encoded, crossed); !errors.Is(err, BindingMismatch) {
		t.Fatalf("source labels bypassed full binding: %v", err)
	}
	j.Schema = "other"
	if _, err := EncodeJournal(j); !errors.Is(err, Invalid) {
		t.Fatalf("new schema admitted: %v", err)
	}
}

func TestParsingNeverInfersLegacyHelperTermination(t *testing.T) {
	op := acceptedOperation()
	base := map[string]any{"schema": "farol.update-restore-intent/1", "action": "rollback", "operation": op, "priorPhase": "verified"}
	for _, mode := range []string{"missing", "null", "null-start", "known-start"} {
		t.Run(mode, func(t *testing.T) {
			v := make(map[string]any)
			for k, x := range base {
				v[k] = x
			}
			switch mode {
			case "null":
				v["helper"] = nil
			case "null-start":
				v["helper"] = map[string]any{"pid": 42, "processStart": nil}
			case "known-start":
				v["helper"] = map[string]any{"pid": 42, "processStart": "same child"}
			}
			data, _ := json.Marshal(v)
			r, err := DecodeRestore(data, op)
			if err != nil || r.HelperPresent != (mode != "missing") {
				t.Fatalf("helper presence lost: %+v, %v", r, err)
			}
			var h *release.Helper
			if r.Helper != nil {
				h = &release.Helper{PID: r.Helper.PID}
				if r.Helper.ProcessStart != nil {
					h.ProcessStart = *r.Helper.ProcessStart
				}
			}
			if release.HelperEnded(h, release.ProcessObservation{PID: 42, State: release.ProcessUnknown}) {
				t.Fatal("retained JSON established process termination")
			}
		})
	}
}

func TestOpaqueManifestAndLosslessInode(t *testing.T) {
	raw := []byte(`{"schema":"farol.ready-update/1","handle":"fixture","manifest": { "unknown": [1, null] },"operation":null}`)
	r, err := DecodeRetained(raw)
	if err != nil || string(r.Manifest) != `{ "unknown": [1, null] }` || r.Operation != nil {
		t.Fatalf("opaque manifest changed: %+v, %v", r, err)
	}
	for i := range raw {
		raw[i] = 'x'
	}
	if string(r.Manifest) != `{ "unknown": [1, null] }` {
		t.Fatal("manifest aliased caller buffer")
	}
	v := map[string]any{"schema": "farol.rejected-update-target/1", "operationId": acceptedOperation().ID, "source": acceptedOperation().Source, "target": acceptedOperation().Target, "directoryIdentity": map[string]string{"device": "18446744073709551615", "inode": "123456789012345678901234567890"}}
	data, _ := json.Marshal(v)
	witness, err := DecodeRejectedTarget(data, acceptedOperation())
	if err != nil || witness.Inode != "123456789012345678901234567890" || witness.Device != "18446744073709551615" {
		t.Fatalf("native identity was numerically coerced: %+v, %v", witness, err)
	}
}

func TestBoundsEncodingAndPrivateErrors(t *testing.T) {
	for _, data := range [][]byte{
		[]byte(`{"private fixture":"value"}`),
		[]byte(`{"schema":true}`),
		[]byte(`null`),
		[]byte(`[]`),
		[]byte(`{} {}`),
		[]byte(`{"v":"\ud800"}`),
		[]byte(`{"v":"\udc00"}`),
		[]byte(`{"v":"\ud800\u0041"}`),
		[]byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'},
	} {
		_, err := DecodeRetained(data)
		if err == nil || (err != Invalid && err != EncodingInvalid) || strings.Contains(err.Error(), "private") {
			t.Fatalf("invalid/private boundary leaked: %v", err)
		}
	}
	if _, err := DecodeRetained(bytes.Repeat([]byte{' '}, MaxRecordBytes+1)); err != Oversized {
		t.Fatalf("unchecked record bound: %v", err)
	}
	op := acceptedOperation()
	j := Journal{Schema: "farol.installed-update-journal/1", Operation: op, Phase: "prepared"}
	data, _ := EncodeJournal(j)
	data = append(data, bytes.Repeat([]byte{' '}, MaxRecordBytes-len(data))...)
	if _, err := DecodeJournal(data, op); err != nil {
		t.Fatalf("exact read bound refused: %v", err)
	}
	j.Source.Version = strings.Repeat("a", MaxHelperRecordBytes)
	if _, err := EncodeJournal(j); err != Oversized {
		t.Fatalf("helper writer bound missed: %v", err)
	}
	// Preserve valid paired Unicode exactly, including a literal escaped backslash.
	if m, err := decode([]byte(`{"v":"\ud83d\ude00","literal":"\\ud800"}`)); err != nil || m["v"] != "😀" || m["literal"] != `\ud800` {
		t.Fatalf("valid Unicode changed: %v, %v", m, err)
	}
	if _, ok := text(strings.Repeat("😀", 64), 0, 128); !ok {
		t.Fatal("UTF-16 max boundary refused")
	}
	if _, ok := text(strings.Repeat("😀", 65), 0, 128); ok {
		t.Fatal("TS persisted string bound widened")
	}
}
