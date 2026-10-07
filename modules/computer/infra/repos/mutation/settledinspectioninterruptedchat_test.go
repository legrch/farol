package mutation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Synthetic canonical bytes only: this suite never opens a store, owner profile,
// native filesystem, app or process and supplies no live preimage-conflict proof.
func interruptedChatSettledPureFixture(t *testing.T) (SettledSelection, []ExpectedSettledRecord, []settledBytes) {
	t.Helper()
	_, _, prepared := connectorV3Fixture(t)
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	var expected []ExpectedSettledRecord
	var entries []settledBytes
	for n := 0; n < interruptedChatSettledRecordCount; n++ {
		b := prepared.Binding()
		b.Identity.OperationID = fmt.Sprintf("interrupted-op-%d", n)
		b.RelativePath = fmt.Sprintf("note-%d.md", n)
		b.Connector.CallID = fmt.Sprintf("interrupted-call-%d", n)
		b.Connector.Operation = domain.WriteKind
		r := domain.Receipt{Operation: domain.WriteKind, RelativePath: b.RelativePath, Bytes: 12, AfterSHA256: strings.Repeat("b", 64)}
		if n%2 == 1 {
			b.Connector.Operation, r.Operation = domain.EditKind, domain.EditKind
			before := strings.Repeat("c", 64)
			r.BeforeSHA256, r.Replacements = &before, 1
		}
		phase, receipt := domain.Completed, &r
		var failure *domain.Failure
		if n == 4 {
			phase, receipt = domain.Failed, nil
			failure = &domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}
		}
		state, err := domain.Restore(b, phase, receipt, failure)
		if err != nil {
			t.Fatal(err)
		}
		raw, err := encode(state)
		if err != nil {
			t.Fatal(err)
		}
		key, err := recordKey(b.Identity)
		if err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256(raw)
		expected = append(expected, ExpectedSettledRecord{Key: key, SHA256: hex.EncodeToString(hash[:]), Binding: b})
		entries = append(entries, settledBytes{key: key, raw: raw})
	}
	return selection, expected, entries
}

func TestInterruptedChatSettledInspectionPureExactSetAndOriginalPolicy(t *testing.T) {
	selection, expected, entries := interruptedChatSettledPureFixture(t)
	before := make([]settledBytes, len(entries))
	for n, e := range entries {
		before[n] = settledBytes{key: e.key, raw: bytes.Clone(e.raw)}
	}
	closed, err := selectInterruptedChatSettled(selection, expected)
	if err != nil {
		t.Fatal(err)
	}
	// Every rotation proves the conflict has no privileged inventory position.
	for rotation := range entries {
		candidate := append(append([]settledBytes(nil), entries[rotation:]...), entries[:rotation]...)
		o := &settledPureObservation{entries: candidate}
		visits := 0
		out, err := observeInterruptedChatSettled(context.Background(), closed, o, func(meta InterruptedChatSettledInspection) error {
			visits++
			if o.rechecks != 1 || meta.Root != o.metadata().Root || meta.MutationsInode != 3 || meta.LockInode != 4 {
				t.Fatal("visitor preceded qualification or lost metadata")
			}
			for n, r := range meta.Retained {
				if r.Key != closed[n].Key || r.SHA256 != closed[n].SHA256 || r.Identity != closed[n].Binding.Identity {
					t.Fatal("retained record is not the selected observation")
				}
				if n > 0 && meta.Retained[n-1].Key >= r.Key {
					t.Fatal("retained set is not sorted and unique")
				}
			}
			meta.Retained[0] = SettledRetainedRecord{}
			return nil
		})
		if err != nil || out == nil || visits != 1 || o.inventories != 1 || o.rechecks != 2 || out.Retained[0].Key == "" {
			t.Fatal("closed set refused or visitor metadata escaped", err)
		}
	}
	if !reflect.DeepEqual(before, entries) {
		t.Fatal("qualification changed original bytes")
	}
	if _, err := selectSettled(selection, expected); err == nil {
		t.Fatal("original inspector selection widened to five")
	}
	// The old policy must still refuse even the exact conflict in a two-record set.
	pair := []ExpectedSettledRecord{expected[0], expected[4]}
	oldClosed := settledPureSelection(t, selection, pair)
	if _, err := qualifySettled([]settledBytes{entries[0], entries[4]}, oldClosed); err == nil {
		t.Fatal("original Completed-only qualification widened")
	}
}

func TestInterruptedChatSettledInspectionPureSelectionRefusals(t *testing.T) {
	for _, name := range []string{"empty", "two", "four", "six", "duplicate-first", "duplicate-last", "key", "digest", "uppercase", "owner", "profile", "computer", "scope", "invalid-origin", "invalid-binding", "empty-selection"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, _ := interruptedChatSettledPureFixture(t)
			switch name {
			case "empty":
				expected = nil
			case "two":
				expected = expected[:2]
			case "four":
				expected = expected[:4]
			case "six":
				expected = append(expected, expected[0])
			case "duplicate-first":
				expected[1] = expected[0]
			case "duplicate-last":
				expected[4] = expected[0]
			case "key":
				expected[0].Key = strings.Repeat("0", 64) + ".json"
			case "digest":
				expected[4].SHA256 = "bad"
			case "uppercase":
				expected[4].SHA256 = strings.Repeat("A", 64)
			case "owner":
				selection.OwnerID += "2"
			case "profile":
				selection.ProfileID += "2"
			case "computer":
				selection.ComputerID += "2"
			case "scope":
				expected[4].Binding.Identity.Scope = domain.ScopeOwnerSettings
			case "invalid-origin":
				expected[4].Binding.Connector.CallID = ""
			case "invalid-binding":
				expected[4].Binding.RelativePath = "../outside"
			case "empty-selection":
				selection = SettledSelection{}
			}
			root := Root{Path: "/private/tmp/never-opened", Device: 1, Inode: 2}
			if out, err := InspectInterruptedChatSettled(context.Background(), root, selection, expected, func(InterruptedChatSettledInspection) error { t.Fatal("visitor called"); return nil }); err == nil || out != nil {
				t.Fatal("invalid selection accepted")
			}
		})
	}
	selection, expected, _ := interruptedChatSettledPureFixture(t)
	closed, err := selectInterruptedChatSettled(selection, expected)
	if err != nil {
		t.Fatal(err)
	}
	expected[0].Binding.Connector.CallID = "caller-changed"
	for _, e := range closed {
		if e.Binding.Connector.CallID == "caller-changed" {
			t.Fatal("selection retained mutable caller slice")
		}
	}
}

func TestInterruptedChatSettledInspectionPureInventoryAndTerminalRefusals(t *testing.T) {
	for _, name := range []string{"missing", "extra", "duplicate", "staging", "swapped-bytes", "malformed", "oversize", "whitespace", "unknown-field", "duplicate-json", "wrong-kind", "old-version", "prepared", "unknown", "other-error", "other-source", "conflict-receipt", "all-completed", "two-conflicts", "write-replacements", "edit-replacements", "receipt-path", "receipt-operation", "task-codec", "owner-codec", "process-codec", "digest-mismatch"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, entries := interruptedChatSettledPureFixture(t)
			closed, err := selectInterruptedChatSettled(selection, expected)
			if err != nil {
				t.Fatal(err)
			}
			setState := func(n int, phase domain.Phase, receipt *domain.Receipt, failure *domain.Failure) {
				t.Helper()
				state, err := domain.Restore(expected[n].Binding, phase, receipt, failure)
				if err != nil {
					t.Fatal(err)
				}
				entries[n].raw, err = encode(state)
				if err != nil {
					t.Fatal(err)
				}
			}
			switch name {
			case "missing":
				entries = entries[:4]
			case "extra":
				entries = append(entries, settledBytes{key: "extra"})
			case "duplicate":
				entries[4] = entries[0]
			case "staging":
				entries[4].key = ".retained.tmp"
			case "swapped-bytes":
				entries[0].raw, entries[4].raw = entries[4].raw, entries[0].raw
			case "malformed":
				entries[4].raw = []byte("{")
			case "oversize":
				entries[4].raw = bytes.Repeat([]byte("x"), maxRecordBytes+1)
			case "whitespace":
				entries[4].raw = append(entries[4].raw, ' ')
			case "unknown-field":
				entries[4].raw = bytes.Replace(entries[4].raw, []byte(`"schemaVersion":3`), []byte(`"schemaVersion":3,"extra":true`), 1)
			case "duplicate-json":
				entries[4].raw = bytes.Replace(entries[4].raw, []byte(`"schemaVersion":3`), []byte(`"schemaVersion":3,"schemaVersion":3`), 1)
			case "wrong-kind":
				entries[4].raw = bytes.Replace(entries[4].raw, []byte("workspace_connector_mutation"), []byte("workspace_mutation"), 1)
			case "old-version":
				entries[4].raw = bytes.Replace(entries[4].raw, []byte(`"schemaVersion":3`), []byte(`"schemaVersion":2`), 1)
			case "prepared":
				setState(4, domain.Prepared, nil, nil)
			case "unknown":
				setState(4, domain.OutcomeUnknown, nil, &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"})
			case "other-error":
				setState(4, domain.Failed, nil, &domain.Failure{Code: "WORKSPACE_HELPER_FAILED", Source: "native-workspace"})
			case "other-source":
				setState(4, domain.Failed, nil, &domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "operation-store"})
			case "conflict-receipt":
				s, err := decode(entries[0].raw)
				if err != nil {
					t.Fatal(err)
				}
				// Domain Restore forbids any Failed receipt; corrupt canonical JSON
				// must remain refused even with an independently matching digest.
				r := s.Receipt()
				r.RelativePath = expected[4].Binding.RelativePath
				completedState, err := domain.Restore(expected[4].Binding, domain.Completed, r, nil)
				if err != nil {
					t.Fatal(err)
				}
				raw, err := encode(completedState)
				if err != nil {
					t.Fatal(err)
				}
				entries[4].raw = bytes.Replace(raw, []byte(`"phase":"completed"`), []byte(`"phase":"failed"`), 1)
			case "all-completed":
				r := domain.Receipt{Operation: domain.WriteKind, RelativePath: expected[4].Binding.RelativePath, Bytes: 12, AfterSHA256: strings.Repeat("b", 64)}
				setState(4, domain.Completed, &r, nil)
			case "two-conflicts":
				setState(0, domain.Failed, nil, &domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"})
			case "write-replacements":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"replacements":0`), []byte(`"replacements":1`), 1)
			case "edit-replacements":
				entries[1].raw = bytes.Replace(entries[1].raw, []byte(`"replacements":1`), []byte(`"replacements":0`), 1)
			case "receipt-path":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"operation":"write","relativePath":"note-0.md"`), []byte(`"operation":"write","relativePath":"wrong.md"`), 1)
			case "receipt-operation":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"kind":"workspace.mutation","operation":"write"`), []byte(`"kind":"workspace.mutation","operation":"edit"`), 1)
			case "task-codec":
				_, _, s := fixture()
				entries[4].raw, err = encode(completed(t, s))
			case "owner-codec":
				_, _, s := ownerFixture(t)
				entries[4].raw, err = encode(completed(t, s))
			case "process-codec":
				_, _, scope, intent := processFixture()
				entries[4].raw, err = encodeProcess(scope, intent)
			case "digest-mismatch":
				closed[0].SHA256 = strings.Repeat("0", 64)
			}
			if err != nil {
				t.Fatal(err)
			}
			if name != "digest-mismatch" {
				// Matching digests cannot authorize malformed, uncertain or extra data.
				for n := range closed {
					for _, e := range entries {
						if e.key == closed[n].Key {
							h := sha256.Sum256(e.raw)
							closed[n].SHA256 = hex.EncodeToString(h[:])
						}
					}
				}
			}
			o := &settledPureObservation{entries: entries}
			if out, err := observeInterruptedChatSettled(context.Background(), closed, o, func(InterruptedChatSettledInspection) error { t.Fatal("unsafe set reached visitor"); return nil }); err == nil || out != nil || o.rechecks != 0 {
				t.Fatal("unsafe inventory qualified")
			}
		})
	}
}

func TestInterruptedChatSettledInspectionPureFullBinding(t *testing.T) {
	for _, field := range []string{"workspace", "path", "request", "computer-generation", "build", "backend", "runtime", "connector-generation", "session", "task", "participant", "turn", "call", "epoch", "generation", "operation"} {
		t.Run(field, func(t *testing.T) {
			selection, expected, entries := interruptedChatSettledPureFixture(t)
			b := &expected[4].Binding
			switch field {
			case "workspace":
				b.WorkspaceID += "2"
			case "path":
				b.RelativePath += "2"
			case "request":
				b.RequestDigest = strings.Repeat("0", 64)
			case "computer-generation":
				b.ComputerGeneration++
			case "build":
				b.Connector.BuildID += "2"
			case "backend":
				b.Connector.BackendGeneration += "2"
			case "runtime":
				b.Connector.RuntimeID += "2"
			case "connector-generation":
				b.Connector.ConnectorGeneration++
			case "session":
				b.Connector.SessionID += "2"
			case "task":
				b.Connector.TaskID += "2"
			case "participant":
				b.Connector.ParticipantID += "2"
			case "turn":
				b.Connector.TurnID += "2"
			case "call":
				b.Connector.CallID += "2"
			case "epoch":
				b.Connector.TaskEpoch++
			case "generation":
				b.Connector.Generation++
			case "operation":
				b.Connector.Operation = domain.EditKind
			}
			closed, err := selectInterruptedChatSettled(selection, expected)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := qualifyInterruptedChatSettled(entries, closed); err == nil {
				t.Fatal("same key/digest bypassed full binding")
			}
		})
	}
}

func TestInterruptedChatSettledInspectionPureCallbackAndRecheck(t *testing.T) {
	for _, name := range []string{"inventory-error", "cancel-inventory", "precheck-error", "postcheck-error", "callback-error", "cancel-visitor"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, entries := interruptedChatSettledPureFixture(t)
			closed, err := selectInterruptedChatSettled(selection, expected)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			o := &settledPureObservation{entries: entries}
			if name == "inventory-error" {
				o.inventoryErr = errors.New("private diagnostic")
			}
			if name == "cancel-inventory" {
				o.onInventory = cancel
			}
			o.check = func(n int) error {
				if name == "precheck-error" && n == 1 || name == "postcheck-error" && n == 2 {
					return errors.New("changed original")
				}
				return nil
			}
			visits := 0
			out, err := observeInterruptedChatSettled(ctx, closed, o, func(InterruptedChatSettledInspection) error {
				visits++
				if name == "callback-error" {
					return errors.New("private callback diagnostic")
				}
				if name == "cancel-visitor" {
					cancel()
				}
				return nil
			})
			if err == nil || out != nil || strings.Contains(err.Error(), "private") {
				t.Fatal("unsafe outcome or raw diagnostic escaped")
			}
			if name == "postcheck-error" || name == "callback-error" || name == "cancel-visitor" {
				if visits != 1 || o.rechecks != 2 {
					t.Fatal("visitor replayed or fresh check skipped")
				}
			} else if visits != 0 {
				t.Fatal("unsafe observation reached visitor")
			}
		})
	}
}

func TestInterruptedChatSettledInspectionPureInvalidInputsNeverOpen(t *testing.T) {
	selection, expected, _ := interruptedChatSettledPureFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	root := Root{Path: "/private/tmp/not-opened", Device: 1, Inode: 2}
	visit := func(InterruptedChatSettledInspection) error { t.Fatal("visitor called"); return nil }
	for _, current := range []context.Context{nil, ctx} {
		if out, err := InspectInterruptedChatSettled(current, root, selection, expected, visit); err == nil || out != nil {
			t.Fatal("invalid context accepted")
		}
	}
	if out, err := InspectInterruptedChatSettled(context.Background(), Root{}, selection, expected, visit); err == nil || out != nil {
		t.Fatal("invalid root accepted")
	}
	if out, err := InspectInterruptedChatSettled(context.Background(), root, selection, expected, nil); err == nil || out != nil {
		t.Fatal("nil visitor accepted")
	}
}
