package mutation

import (
	"bytes"
	"context"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Canonical synthetic result bytes; this proves storage preservation only.
func preservedResultFixture(t *testing.T, write bool) (SettledSelection, []ExpectedPreservedRecord, []settledBytes) {
	t.Helper()
	selection, expected, entries := preservedPureFixture(t)
	value := terminalValue(bytes.Repeat([]byte("a"), processOutputChunkBytes+1), []byte("error"))
	value.Intent.OperationID = "known-result"
	value.Intent.Seal.Write = write
	value.Observation.Supervisor = processsvc.SupervisorExited
	value.Observation.GroupCleanup = processsvc.CleanupUnverified
	value.Observation.DescendantCleanup = processsvc.CleanupUnverified
	if write {
		value.Observation.GroupCleanup = processsvc.CleanupConfirmed
		value.Observation.DescendantCleanup = processsvc.CleanupConfirmed
	}
	raw, chunks, err := encodeProcessTerminal(value)
	if err != nil {
		t.Fatal(err)
	}
	identity := processIdentity(value.Scope, value.Intent.OperationID)
	parent, err := recordKey(identity)
	if err != nil {
		t.Fatal(err)
	}
	entries = append(entries, settledBytes{key: parent, raw: raw})
	expected = append(expected, ExpectedPreservedRecord{Key: parent, SHA256: preservedDigest(raw), Identity: identity})
	for _, chunk := range chunks {
		entries = append(entries, settledBytes{key: chunk.key, raw: chunk.raw})
		expected = append(expected, ExpectedPreservedRecord{Key: chunk.key, SHA256: preservedDigest(chunk.raw), Identity: identity, OutputParent: parent})
	}
	return selection, expected, entries
}

func TestPreservedProcessResultsKeepExactBytesWithoutClaimingCleanup(t *testing.T) {
	for _, write := range []bool{false, true} {
		selection, expected, entries := preservedResultFixture(t, write)
		before := make(map[string][]byte)
		for _, e := range entries {
			before[e.key] = bytes.Clone(e.raw)
		}
		closed := preservedPureSelection(t, selection, expected)
		o := &settledPureObservation{entries: entries}
		calls := 0
		result, err := observePreserved(context.Background(), closed, o, func(meta PreservedInspection) error {
			calls++
			for n, record := range meta.Retained {
				if record.Key != closed[n].Key || record.SHA256 != closed[n].SHA256 {
					t.Fatal("receipt pairs the wrong filename with preserved bytes")
				}
			}
			if meta.ReservedProcesses != 1 || len(meta.Retained) != len(entries) {
				t.Fatal("incomplete inventory")
			}
			return nil
		})
		if err != nil || result == nil || calls != 1 || o.rechecks != 2 {
			t.Fatal("result preservation refused", err)
		}
		for _, e := range entries {
			if !bytes.Equal(before[e.key], e.raw) {
				t.Fatal("record rewritten")
			}
		}
		for _, e := range entries {
			var h struct {
				Version uint8       `json:"schemaVersion"`
				Kind    string      `json:"kind"`
				Record  interface{} `json:"record"`
			}
			if decodeStrict(e.raw, &h) != nil {
				t.Fatal("bad fixture")
			}
			if h.Version != 6 {
				continue
			}
			v, _, err := decodeProcessTerminal(e.raw)
			expectedCleanup := processsvc.CleanupUnverified
			if write {
				expectedCleanup = processsvc.CleanupConfirmed
			}
			if err != nil || v.Observation.GroupCleanup != expectedCleanup || v.Observation.DescendantCleanup != expectedCleanup {
				t.Fatal("cleanup was upgraded")
			}
		}
	}
}

func TestPreservedProcessResultsRefuseIncompleteOrCrossedOutput(t *testing.T) {
	for _, name := range []string{"missing-chunk", "orphan", "crossed-parent", "crossed-identity", "changed-content", "changed-terminal", "missing-result", "duplicate-chunk"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, entries := preservedResultFixture(t, false)
			n := len(entries) - 1
			switch name {
			case "missing-chunk":
				entries, expected = entries[:n], expected[:n]
			case "orphan":
				v := terminalValue([]byte("orphan"), nil)
				v.Intent.OperationID = "other-result"
				v.Observation.Supervisor = processsvc.SupervisorExited
				_, chunks, err := encodeProcessTerminal(v)
				if err != nil {
					t.Fatal(err)
				}
				id := processIdentity(v.Scope, v.Intent.OperationID)
				parent, _ := recordKey(id)
				entries = append(entries, settledBytes{key: chunks[0].key, raw: chunks[0].raw})
				expected = append(expected, ExpectedPreservedRecord{Key: chunks[0].key, SHA256: preservedDigest(chunks[0].raw), Identity: id, OutputParent: parent})
			case "crossed-parent":
				expected[n].OutputParent = expected[3].Key
			case "crossed-identity":
				expected[n].Identity.OperationID = "other-result"
			case "changed-content":
				entries[n].raw = bytes.Replace(entries[n].raw, []byte(`"stream":"stderr"`), []byte(`"stream":"stdout"`), 1)
				expected[n].SHA256 = preservedDigest(entries[n].raw)
			case "changed-terminal":
				entries[4].raw = bytes.Replace(entries[4].raw, []byte(`"supervisorState":"exited"`), []byte(`"supervisorState":"unknown"`), 1)
				expected[4].SHA256 = preservedDigest(entries[4].raw)
			case "missing-result":
				entries = append(entries[:4], entries[5:]...)
				expected = append(expected[:4], expected[5:]...)
			case "duplicate-chunk":
				entries = append(entries, entries[n])
				expected = append(expected, expected[n])
			}
			closed, err := selectPreserved(selection, expected)
			if err != nil {
				return
			}
			calls := 0
			value, err := observePreserved(context.Background(), closed, &settledPureObservation{entries: entries}, func(PreservedInspection) error { calls++; return nil })
			if err == nil || value != nil || calls != 0 {
				t.Fatal("invalid result reached visitor")
			}
		})
	}
}

func TestPreservedProcessResultsRefuseWriteWithoutCompleteCleanup(t *testing.T) {
	for _, cleanup := range []struct {
		name               string
		group, descendants processsvc.Cleanup
	}{
		{"both-unverified", processsvc.CleanupUnverified, processsvc.CleanupUnverified},
		{"descendants-unverified", processsvc.CleanupConfirmed, processsvc.CleanupUnverified},
		{"group-unverified", processsvc.CleanupUnverified, processsvc.CleanupConfirmed},
	} {
		t.Run(cleanup.name, func(t *testing.T) {
			selection, expected, entries := preservedResultFixture(t, true)
			value := terminalValue(nil, nil)
			value.Intent.OperationID = "known-result"
			value.Intent.Seal.Write = true
			value.Observation.Supervisor = processsvc.SupervisorExited
			value.Observation.GroupCleanup, value.Observation.DescendantCleanup = cleanup.group, cleanup.descendants
			raw, _, err := encodeProcessTerminal(value)
			if err != nil {
				t.Fatal(err)
			}
			entries, expected = entries[:5], expected[:5]
			entries[4].raw = raw
			expected[4].SHA256 = preservedDigest(raw)
			closed := preservedPureSelection(t, selection, expected)
			calls := 0
			result, err := observePreserved(context.Background(), closed, &settledPureObservation{entries: entries}, func(PreservedInspection) error { calls++; return nil })
			if err == nil || result != nil || calls != 0 {
				t.Fatal("unverified writer reached maintenance visitor")
			}
		})
	}
}
