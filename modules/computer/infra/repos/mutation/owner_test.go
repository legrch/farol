package mutation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Synthetic canonical receipts only: no app publication, process or ACK proof.
func ownerInspectionFixture(t *testing.T, count int) (OwnerSelection, []ExpectedOwnerRecord, []settledBytes) {
	t.Helper()
	_, _, prepared := ownerFixture(t)
	selection := OwnerSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	var expected []ExpectedOwnerRecord
	var entries []settledBytes
	for n := 0; n < count; n++ {
		b := prepared.Binding()
		b.Identity.OperationID = fmt.Sprintf("owner-%03d", n)
		receipt := domain.Receipt{Operation: domain.WriteKind, RelativePath: b.RelativePath, Bytes: 12, AfterSHA256: strings.Repeat("b", 64)}
		if n%2 != 0 {
			before := strings.Repeat("c", 64)
			receipt.Operation, receipt.Replacements, receipt.BeforeSHA256 = domain.EditKind, 1, &before
		}
		state, err := domain.Restore(b, domain.Completed, &receipt, nil)
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
		expected = append(expected, ExpectedOwnerRecord{Key: key, SHA256: ownerInspectionHash(raw), Binding: b})
		entries = append(entries, settledBytes{key: key, raw: raw})
	}
	return selection, expected, entries
}

func ownerInspectionHash(raw []byte) string {
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func ownerTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	bounded, err := boundOwnerInspection(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return bounded
}

func TestOwnerInspectionPureBoundsAndCopies(t *testing.T) {
	for _, count := range []int{1, 2, 5, 128} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			selection, expected, entries := ownerInspectionFixture(t, count)
			original := append([]ExpectedOwnerRecord(nil), expected...)
			closed, err := selectOwner(selection, expected)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(original, expected) {
				t.Fatal("selection reordered caller inputs")
			}
			expected[0] = ExpectedOwnerRecord{}
			o := &settledPureObservation{entries: entries}
			before := make([]settledBytes, len(entries))
			for n, entry := range entries {
				before[n] = settledBytes{key: entry.key, raw: bytes.Clone(entry.raw)}
			}
			var callback OwnerInspection
			out, err := observeOwnerCompleted(ownerTestContext(t), closed, o, func(meta OwnerInspection) error {
				callback = meta
				if len(meta.Retained) != count {
					t.Fatal("lost retained records")
				}
				for n, r := range meta.Retained {
					if r.Key != closed[n].Key || r.SHA256 != closed[n].SHA256 || r.Identity != closed[n].Binding.Identity {
						t.Fatal("lost immutable observation")
					}
				}
				meta.Retained[0] = OwnerRetainedRecord{}
				return nil
			})
			if err != nil || out == nil || o.inventories != 1 || o.rechecks != 2 || out.Retained[0].Key == "" {
				t.Fatal(out, err, o)
			}
			out.Retained[0].Key = "returned-mutation"
			if callback.Retained[0].Key != "" || closed[0].Key == "returned-mutation" {
				t.Fatal("callback/result/input alias")
			}
			if !reflect.DeepEqual(before, entries) {
				t.Fatal("qualification changed observation")
			}
		})
	}
}

func TestOwnerInspectionPureSelectionRefusals(t *testing.T) {
	cases := map[string]func(*OwnerSelection, *[]ExpectedOwnerRecord){
		"zero":           func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { *e = nil },
		"129":            func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { *e = make([]ExpectedOwnerRecord, 129) },
		"duplicate":      func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[1] = (*e)[0] },
		"key":            func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].Key = "../outside" },
		"hash":           func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].SHA256 = "bad" },
		"upper-hash":     func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].SHA256 = strings.Repeat("A", 64) },
		"owner":          func(s *OwnerSelection, _ *[]ExpectedOwnerRecord) { s.OwnerID = "other" },
		"profile":        func(s *OwnerSelection, _ *[]ExpectedOwnerRecord) { s.ProfileID = "other" },
		"computer":       func(s *OwnerSelection, _ *[]ExpectedOwnerRecord) { s.ComputerID = "other" },
		"empty-selector": func(s *OwnerSelection, _ *[]ExpectedOwnerRecord) { s.OwnerID = "" },
		"large-selector": func(s *OwnerSelection, _ *[]ExpectedOwnerRecord) { s.ProfileID = strings.Repeat("x", 161) },
		"task-scope":     func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].Binding.Identity.Scope = "" },
		"connector-scope": func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) {
			(*e)[0].Binding.Identity.Scope = domain.ScopeConnector
		},
		"task-identity":   func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].Binding.Identity.TaskID = "task" },
		"empty-operation": func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].Binding.Identity.OperationID = "" },
		"generation": func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) {
			(*e)[0].Binding.ComputerGeneration = domain.MaxSafeInteger + 1
		},
		"workspace":      func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].Binding.WorkspaceID = "" },
		"path":           func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].Binding.RelativePath = "../outside" },
		"request-digest": func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].Binding.RequestDigest = "bad" },
		"origin":         func(_ *OwnerSelection, e *[]ExpectedOwnerRecord) { (*e)[0].Binding.Connector.CallID = "call" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			s, expected, _ := ownerInspectionFixture(t, 2)
			change(&s, &expected)
			if got, err := selectOwner(s, expected); err == nil || got != nil {
				t.Fatal("invalid selection accepted")
			}
		})
	}
}

func TestOwnerInspectionPureCanonicalAndInventoryRefusals(t *testing.T) {
	for _, name := range []string{"empty", "missing", "extra", "duplicate", "stage", "swapped", "altered", "bad-json", "oversize", "noncanonical", "duplicate-field", "v1", "v3", "v4", "prepared", "failed", "unknown", "write-shape", "edit-shape", "receipt-path", "binding-generation", "binding-path", "binding-workspace", "binding-digest", "cross-owner", "cross-profile", "cross-computer"} {
		t.Run(name, func(t *testing.T) {
			s, expected, entries := ownerInspectionFixture(t, 2)
			closed, err := selectOwner(s, expected)
			if err != nil {
				t.Fatal(err)
			}
			state, err := decode(entries[0].raw)
			if err != nil {
				t.Fatal(err)
			}
			b := state.Binding()
			switch name {
			case "empty":
				entries = nil
			case "missing":
				entries = entries[:1]
			case "extra":
				entries = append(entries, entries[0])
			case "duplicate":
				entries[1] = entries[0]
			case "stage":
				entries[0].key = ".retained.tmp"
			case "swapped":
				entries[0].raw, entries[1].raw = entries[1].raw, entries[0].raw
			case "altered":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"bytes":12`), []byte(`"bytes":13`), 1)
			case "bad-json":
				entries[0].raw = []byte("{")
			case "oversize":
				entries[0].raw = bytes.Repeat([]byte("x"), maxRecordBytes+1)
			case "noncanonical":
				entries[0].raw = append(entries[0].raw, ' ')
			case "duplicate-field":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":2,"schemaVersion":2`), 1)
			case "v1", "v3", "v4":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"schemaVersion":2`), []byte(`"schemaVersion":`+name[1:]), 1)
			case "prepared", "failed", "unknown":
				state, err = domain.NewPrepared(b)
				if name != "prepared" {
					f := domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}
					if name == "unknown" {
						f.Code = "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
					}
					state, err = state.Refuse(f)
				}
				if err != nil {
					t.Fatal(err)
				}
				entries[0].raw, err = encode(state)
				if err != nil {
					t.Fatal(err)
				}
			case "write-shape":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"replacements":0`), []byte(`"replacements":1`), 1)
			case "edit-shape":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"operation":"write"`), []byte(`"operation":"edit"`), 1)
			case "receipt-path":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"relativePath":"file.md"`), []byte(`"relativePath":"other.md"`), 1)
			case "binding-generation":
				b.ComputerGeneration++
			case "binding-path":
				b.RelativePath = "other.md"
			case "binding-workspace":
				b.WorkspaceID = "other"
			case "binding-digest":
				b.RequestDigest = strings.Repeat("d", 64)
			case "cross-owner":
				b.Identity.OwnerID = "other"
			case "cross-profile":
				b.Identity.ProfileID = "other"
			case "cross-computer":
				b.Identity.ComputerID = "other"
			}
			if strings.HasPrefix(name, "binding-") || strings.HasPrefix(name, "cross-") {
				receipt := state.Receipt()
				receipt.RelativePath = b.RelativePath
				state, err = domain.Restore(b, domain.Completed, receipt, nil)
				if err != nil {
					t.Fatal(err)
				}
				entries[0].raw, err = encode(state)
				if err != nil {
					t.Fatal(err)
				}
			}
			// Rebind the independently selected byte digest except in the digest
			// mismatch case, so codec/phase/binding checks must themselves refuse.
			if name != "altered" && len(entries) > 0 {
				for n := range closed {
					for _, entry := range entries {
						if entry.key == closed[n].Key {
							closed[n].SHA256 = ownerInspectionHash(entry.raw)
						}
					}
				}
			}
			if out, err := qualifyOwner(entries, closed); err == nil || out != nil {
				t.Fatal("unsafe owner records accepted", name)
			}
		})
	}
	// Valid canonical neighboring policies remain disjoint in both directions.
	s, expected, _ := settledPureFixture(t)
	owner := make([]ExpectedOwnerRecord, len(expected))
	for n, e := range expected {
		owner[n] = ExpectedOwnerRecord{Key: e.Key, SHA256: e.SHA256, Binding: e.Binding}
	}
	if _, err := selectOwner(OwnerSelection{OwnerID: s.OwnerID, ProfileID: s.ProfileID, ComputerID: s.ComputerID}, owner); err == nil {
		t.Fatal("connector selection admitted")
	}
	_, owners, _ := ownerInspectionFixture(t, 2)
	for n, e := range owners {
		expected[n] = ExpectedSettledRecord{Key: e.Key, SHA256: e.SHA256, Binding: e.Binding}
	}
	if _, err := selectSettled(s, expected); err == nil {
		t.Fatal("old exact-two predicate broadened")
	}
}

// A valid neighboring canonical record still refuses with its exact byte digest,
// including when mixed into an otherwise valid owner set.
func TestOwnerInspectionPureCanonicalNeighborRefusal(t *testing.T) {
	_, _, task := fixture()
	taskRaw, err := encode(completed(t, task))
	if err != nil {
		t.Fatal(err)
	}
	_, _, connectors := settledPureFixture(t)
	_, _, scope, intent := processFixture()
	processRaw, err := encodeProcess(scope, intent)
	if err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string][]byte{"task-v1": taskRaw, "connector-v3": connectors[0].raw, "process-v4": processRaw} {
		t.Run(name, func(t *testing.T) {
			selection, expected, entries := ownerInspectionFixture(t, 2)
			entries[0].raw = raw
			expected[0].SHA256 = ownerInspectionHash(raw)
			closed, err := selectOwner(selection, expected)
			if err != nil {
				t.Fatal(err)
			}
			if out, err := qualifyOwner(entries, closed); err == nil || out != nil {
				t.Fatal("canonical neighbor admitted")
			}
		})
	}
}

// Models a context whose absolute deadline has expired before its timer updates
// Err/Done. Deadline is deliberately mutable to detect accidental renewal.
type ownerLagContext struct {
	context.Context
	deadline time.Time
	calls    int
}

func (c *ownerLagContext) Deadline() (time.Time, bool) { c.calls++; return c.deadline, true }

func TestOwnerInspectionPureDeadlineCapture(t *testing.T) {
	for _, ctx := range []context.Context{nil, context.Background(), &ownerLagContext{Context: context.Background(), deadline: time.Now().Add(-time.Second)}} {
		if _, err := boundOwnerInspection(ctx); err == nil {
			t.Fatal("missing/expired original deadline accepted")
		}
	}
	lag := &ownerLagContext{Context: context.Background(), deadline: time.Now().Add(100 * time.Millisecond)}
	bounded, err := boundOwnerInspection(lag)
	if err != nil {
		t.Fatal(err)
	}
	original, _ := bounded.Deadline()
	lag.deadline = original.Add(time.Hour)
	time.Sleep(time.Until(original) + time.Millisecond)
	if bounded.Err() != context.DeadlineExceeded || lag.Err() != nil || lag.calls != 1 {
		t.Fatal("renewed bound or trusted lagging timer", lag.calls)
	}
}

func TestOwnerInspectionPureVisitorAndFinalChecks(t *testing.T) {
	for _, name := range []string{"success", "visitor-error", "cancel-visitor", "late-visitor", "late-visitor-nil", "postcheck-error", "postcheck-cancel", "postcheck-expiry", "inventory-cancel", "precheck-error"} {
		t.Run(name, func(t *testing.T) {
			s, expected, entries := ownerInspectionFixture(t, 2)
			closed, err := selectOwner(s, expected)
			if err != nil {
				t.Fatal(err)
			}
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			lag := &ownerLagContext{Context: parent, deadline: time.Now().Add(time.Hour)}
			if strings.HasPrefix(name, "late-visitor") || name == "postcheck-expiry" {
				lag.deadline = time.Now().Add(100 * time.Millisecond)
			}
			bounded, err := boundOwnerInspection(lag)
			if err != nil {
				t.Fatal(err)
			}
			o := &settledPureObservation{entries: entries}
			if name == "inventory-cancel" {
				o.onInventory = cancel
			}
			o.check = func(n int) error {
				if name == "precheck-error" && n == 1 || name == "postcheck-error" && n == 2 {
					return errors.New("unqualified final state")
				}
				if n == 2 && name == "postcheck-cancel" {
					cancel()
				}
				if n == 2 && name == "postcheck-expiry" {
					time.Sleep(time.Until(lag.deadline) + time.Millisecond)
				}
				return nil
			}
			sentinel := errors.New("trusted visitor error")
			visits := 0
			out, err := observeOwnerCompleted(bounded, closed, o, func(OwnerInspection) error {
				visits++
				if name == "cancel-visitor" {
					cancel()
				}
				if strings.HasPrefix(name, "late-visitor") {
					time.Sleep(time.Until(lag.deadline) + time.Millisecond)
				}
				if name == "success" || name == "late-visitor-nil" {
					return nil
				}
				return sentinel
			})
			if name == "success" {
				if err != nil || out == nil {
					t.Fatal(out, err)
				}
			} else {
				if err == nil || out != nil {
					t.Fatal("failed observation returned result", out, err)
				}
				if (name == "visitor-error") != errors.Is(err, sentinel) {
					t.Fatal("error precedence changed", err)
				}
			}
			if name == "inventory-cancel" || name == "precheck-error" {
				if visits != 0 {
					t.Fatal("visitor ran after initial refusal")
				}
			} else if visits != 1 || o.rechecks != 2 {
				t.Fatal("missing final check or repeated visitor", visits, o.rechecks)
			}
			if lag.calls != 1 {
				t.Fatal("deadline renewed", lag.calls)
			}
		})
	}
}

func TestOwnerInspectionPureInvalidPublicInputs(t *testing.T) {
	s, expected, _ := ownerInspectionFixture(t, 1)
	ctx, cancel := context.WithCancel(ownerTestContext(t))
	cancel()
	root := Root{Path: "/private/tmp/not-opened", Device: 1, Inode: 2}
	for _, current := range []context.Context{nil, context.Background(), ctx} {
		if out, err := InspectOwnerCompleted(current, root, s, expected, func(OwnerInspection) error { t.Fatal("visitor called"); return nil }); err == nil || out != nil {
			t.Fatal("invalid context accepted")
		}
	}
	if out, err := InspectOwnerCompleted(ownerTestContext(t), Root{}, s, expected, func(OwnerInspection) error { return nil }); err == nil || out != nil {
		t.Fatal("invalid root accepted")
	}
	if out, err := InspectOwnerCompleted(ownerTestContext(t), root, s, expected, nil); err == nil || out != nil {
		t.Fatal("nil visitor accepted")
	}
	if runtime.GOOS != "darwin" {
		if out, err := InspectOwnerCompleted(ownerTestContext(t), root, s, expected, func(OwnerInspection) error { t.Fatal("unsupported native visitor"); return nil }); err == nil || out != nil {
			t.Fatal("unsupported platform accepted")
		}
	}
}
