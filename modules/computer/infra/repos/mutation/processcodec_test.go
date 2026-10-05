package mutation

import (
	"bytes"
	"strconv"
	"strings"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

func TestConnectorProcessCanonicalVectorAndFullCounters(t *testing.T) {
	_, _, s, i := processFixture()
	want := `{"schemaVersion":4,"kind":"workspace_connector_process","record":{"scope":{"host":{"profileId":"profile","backendGeneration":"backend","buildId":"build","runtimeId":"runtime","launchDigest":"` + strings.Repeat("b", 64) + `","connectorGeneration":"2"},"ownerId":"owner","computerId":"computer","callId":"call","computerGeneration":"7","generation":"4"},"intent":{"operationId":"op","binding":{"ownerId":"owner","sessionId":"session","taskId":"task","taskEpoch":"3","participantId":"participant","turnId":"turn"},"seal":{"digest":"` + strings.Repeat("a", 64) + `","workspaceId":"work","root":"/workspace/code","cwd":"/workspace/code/sub","device":"12","inode":"34","write":false},"deadlineUnixNano":"1900000000123456789"},"phase":"reserved"}}` + "\n"
	raw, err := encodeProcess(s, i)
	if err != nil || string(raw) != want {
		t.Fatalf("canonical format drift: %s %v", raw, err)
	}
	for _, counter := range []uint64{0, 1, 9007199254740993, 1<<63 + 3, ^uint64(0)} {
		t.Run(strconv.FormatUint(counter, 10), func(t *testing.T) {
			s.ComputerGeneration, s.Generation, i.Binding.TaskEpoch = counter, counter, counter
			s.Host.ConnectorGeneration = counter
			if counter == 0 {
				s.Host.ConnectorGeneration = 1
			}
			i.Seal.RootIdentity.Device, i.Seal.RootIdentity.Inode = strconv.FormatUint(counter, 10), strconv.FormatUint(counter, 10)
			raw, err := encodeProcess(s, i)
			if err != nil {
				t.Fatal(err)
			}
			gotScope, gotIntent, err := decodeProcess(raw)
			if err != nil || gotScope != s || gotIntent.Binding != i.Binding || gotIntent.Seal != i.Seal || !gotIntent.Deadline.Equal(i.Deadline) {
				t.Fatal("counter lost", err)
			}
			if !bytes.Contains(raw, []byte(`"taskEpoch":"`+strconv.FormatUint(counter, 10)+`"`)) {
				t.Fatal("counter not lossless decimal string")
			}
		})
	}
	for _, n := range []int64{1, 1900000000123456789, 1<<63 - 1} {
		i.Deadline = time.Unix(0, n)
		raw, err := encodeProcess(s, i)
		if err != nil {
			t.Fatal(err)
		}
		_, out, err := decodeProcess(raw)
		if err != nil || !out.Deadline.Equal(i.Deadline) {
			t.Fatal("deadline did not roundtrip", err)
		}
	}
}

func TestConnectorProcessStrictCanonicalDecode(t *testing.T) {
	_, _, s, i := processFixture()
	raw, err := encodeProcess(s, i)
	if err != nil {
		t.Fatal(err)
	}
	base := string(raw)
	variants := map[string]string{
		"unknown":           strings.Replace(base, `"phase":"reserved"`, `"phase":"reserved","argv":[]`, 1),
		"missing-false":     strings.Replace(base, `,"write":false`, ``, 1),
		"missing":           strings.Replace(base, `"callId":"call",`, ``, 1),
		"duplicate":         strings.Replace(base, `"ownerId":"owner"`, `"ownerId":"owner","ownerId":"owner"`, 1),
		"case":              strings.Replace(base, `"callId"`, `"CallId"`, 1),
		"alternate-version": strings.Replace(base, `"schemaVersion":4`, `"schemaVersion":3`, 1),
		"fraction-version":  strings.Replace(base, `"schemaVersion":4`, `"schemaVersion":4.0`, 1),
		"kind":              strings.Replace(base, `workspace_connector_process`, `workspace_connector_mutation`, 1),
		"terminal":          strings.Replace(base, `"phase":"reserved"`, `"phase":"completed"`, 1),
		"newline":           strings.TrimSuffix(base, "\n"),
		"whitespace":        " " + base,
		"trailing":          base + "{}",
		"escape":            strings.Replace(base, `"call"`, `"\u0063all"`, 1),
		"surrogate":         strings.Replace(base, `"call"`, `"\ud800"`, 1),
		"utf8":              strings.Replace(base, `"call"`, "\"\xff\"", 1),
		"null":              strings.Replace(base, `"callId":"call"`, `"callId":null`, 1),
		"owner-mismatch":    strings.Replace(base, `"binding":{"ownerId":"owner"`, `"binding":{"ownerId":"other"`, 1),
		"oversized":         strings.Repeat(" ", maxRecordBytes+1),
	}
	for _, field := range []string{"connectorGeneration", "computerGeneration", "generation", "taskEpoch", "device", "inode", "deadlineUnixNano"} {
		old := map[string]string{"connectorGeneration": "2", "computerGeneration": "7", "generation": "4", "taskEpoch": "3", "device": "12", "inode": "34", "deadlineUnixNano": "1900000000123456789"}[field]
		for _, bad := range []string{"01", "+1", "-1", "1.0", "1e0", "18446744073709551616", "", "9007199254740993.0"} {
			variants[field+"-"+bad] = strings.Replace(base, `"`+field+`":"`+old+`"`, `"`+field+`":"`+bad+`"`, 1)
		}
		variants[field+"-number"] = strings.Replace(base, `"`+field+`":"`+old+`"`, `"`+field+`":`+old, 1)
	}
	variants["deadline-overflow"] = strings.Replace(base, `"1900000000123456789"`, `"9223372036854775808"`, 1)
	variants["deadline-zero"] = strings.Replace(base, `"1900000000123456789"`, `"0"`, 1)
	for name, bad := range variants {
		t.Run(name, func(t *testing.T) {
			if bad == base {
				t.Fatal("ineffective vector")
			}
			_, _, err := decodeProcess([]byte(bad))
			code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
		})
	}
	if _, err := decode(raw); err == nil {
		t.Fatal("legacy parser widened to v4")
	}
	_, _, state := connectorV3Fixture(t)
	old, _ := encode(state)
	_, _, err = decodeProcess(old)
	code(t, err, "WORKSPACE_MUTATION_STATE_CORRUPT")
}

func TestConnectorProcessInvalidInputZeroStoreIO(t *testing.T) {
	changes := map[string]func(*processsvc.ConnectorReservationScope, *processsvc.Intent){
		"owner":    func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.OwnerID = "" },
		"computer": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.ComputerID = "bad id" },
		"profile":  func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Host.ProfileID = "\x00" },
		"backend": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) {
			s.Host.BackendGeneration = strings.Repeat("a", 121)
		},
		"build":   func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Host.BuildID = "\xff" },
		"runtime": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Host.RuntimeID = "" },
		"launch": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) {
			s.Host.LaunchDigest = strings.Repeat("A", 64)
		},
		"connector-generation": func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.Host.ConnectorGeneration = 0 },
		"call":                 func(s *processsvc.ConnectorReservationScope, _ *processsvc.Intent) { s.CallID = "" },
		"operation":            func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.OperationID = "" },
		"binding-owner":        func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.OwnerID = "other" },
		"session":              func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.SessionID = "" },
		"task":                 func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.TaskID = "bad id" },
		"participant":          func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.ParticipantID = "" },
		"turn":                 func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Binding.TurnID = "" },
		"seal":                 func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Digest = "bad" },
		"workspace":            func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.WorkspaceID = "" },
		"root-relative":        func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Root = "relative" },
		"root-dot": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Seal.Root = "/workspace/../code"
		},
		"cwd-escape":   func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Cwd = "/workspace/code2" },
		"cwd-relative": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Cwd = "relative" },
		"cwd-slashes": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Seal.Cwd = "/workspace/code//sub"
		},
		"cwd-trailing":  func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Cwd += "/" },
		"cwd-control":   func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Cwd += "\n" },
		"cwd-backslash": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.Cwd += "\\bad" },
		"cwd-long-component": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Seal.Cwd += "/" + strings.Repeat("a", 256)
		},
		"cwd-long-path": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Seal.Cwd += strings.Repeat("/a", 2100)
		},
		"device": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Seal.RootIdentity.Device = "01" },
		"inode-overflow": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Seal.RootIdentity.Inode = "18446744073709551616"
		},
		"deadline-zero":     func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Deadline = time.Time{} },
		"deadline-negative": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Deadline = time.Unix(0, -1) },
		"deadline-overflow": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) {
			i.Deadline = time.Unix(0, 1<<63-1).Add(time.Nanosecond)
		},
		"deadline-overflow-positive-wrap": func(_ *processsvc.ConnectorReservationScope, i *processsvc.Intent) { i.Deadline = time.Unix(1<<36, 1) },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			r, m, s, i := processFixture()
			change(&s, &i)
			a, err := r.ConnectorProcessReservation(s)
			if err == nil {
				_, err = a.Reserve(t.Context(), i)
			}
			code(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
			if m.checks+m.reads+m.creates+m.replaces+m.closes != 0 {
				t.Fatal("invalid input touched storage")
			}
		})
	}
}
