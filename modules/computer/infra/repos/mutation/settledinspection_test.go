package mutation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"strings"
	"testing"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Synthetic canonical receipts only. No native constructor, files, profiles,
// processes, host observation or effects are exercised by this named suite.
func settledPureFixture(t *testing.T) (SettledSelection, []ExpectedSettledRecord, []settledBytes) {
	t.Helper()
	_, _, prepared := connectorV3Fixture(t)
	selection := SettledSelection{OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}
	var expected []ExpectedSettledRecord
	var entries []settledBytes
	for n, kind := range []domain.Kind{domain.WriteKind, domain.EditKind} {
		b := prepared.Binding()
		b.Identity.OperationID = []string{"write-op", "edit-op"}[n]
		b.RelativePath = []string{"write.md", "edit.md"}[n]
		b.Connector.Operation = kind
		b.Connector.CallID = []string{"write-call", "edit-call"}[n]
		receipt := domain.Receipt{Operation: kind, RelativePath: b.RelativePath, Bytes: 12, AfterSHA256: strings.Repeat("b", 64)}
		if kind == domain.EditKind {
			before := strings.Repeat("c", 64)
			receipt.BeforeSHA256, receipt.Replacements = &before, 1
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
		hash := sha256.Sum256(raw)
		expected = append(expected, ExpectedSettledRecord{Key: key, SHA256: hex.EncodeToString(hash[:]), Binding: b})
		entries = append(entries, settledBytes{key: key, raw: raw})
	}
	return selection, expected, entries
}

func settledPureSelection(t *testing.T, selection SettledSelection, expected []ExpectedSettledRecord) [settledRecordCount]ExpectedSettledRecord {
	t.Helper()
	closed, err := selectSettled(selection, expected)
	if err != nil {
		t.Fatal(err)
	}
	return closed
}

type settledPureObservation struct {
	entries               []settledBytes
	inventories, rechecks int
	inventoryErr          error
	onInventory           func()
	check                 func(int) error
}

func (o *settledPureObservation) inventory() ([]settledBytes, error) {
	o.inventories++
	if o.onInventory != nil {
		o.onInventory()
	}
	return o.entries, o.inventoryErr
}
func (o *settledPureObservation) recheck([]settledBytes) error {
	o.rechecks++
	if o.check != nil {
		return o.check(o.rechecks)
	}
	return nil
}
func (*settledPureObservation) metadata() SettledInspection {
	return SettledInspection{Root: Root{Path: "/private/tmp/synthetic-not-opened", Device: 1, Inode: 2}, MutationsDevice: 1, MutationsInode: 3, LockDevice: 1, LockInode: 4}
}

func TestSettledInspectionPureExactCanonicalClosedSet(t *testing.T) {
	selection, expected, entries := settledPureFixture(t)
	closed := settledPureSelection(t, selection, expected)
	before := make([]settledBytes, len(entries))
	for i, e := range entries {
		before[i] = settledBytes{key: e.key, raw: bytes.Clone(e.raw)}
	}
	for _, reverse := range []bool{false, true} {
		candidate := append([]settledBytes(nil), entries...)
		if reverse {
			candidate[0], candidate[1] = candidate[1], candidate[0]
		}
		o := &settledPureObservation{entries: candidate}
		visits := 0
		out, err := observeSettled(context.Background(), closed, o, func(meta SettledInspection) error {
			visits++
			if o.rechecks != 1 || meta.Retained[0].Key >= meta.Retained[1].Key {
				t.Fatal("visitor preceded full qualification or inventory was unordered")
			}
			for n, observed := range meta.Retained {
				if observed.Identity != closed[n].Binding.Identity || observed.Key != closed[n].Key || observed.SHA256 != closed[n].SHA256 {
					t.Fatal("metadata was not the observed expected record")
				}
			}
			// Value metadata cannot rewrite the returned observation.
			meta.Retained[0] = SettledRetainedRecord{}
			return nil
		})
		if err != nil || out == nil || visits != 1 || o.inventories != 1 || o.rechecks != 2 || out.Retained[0].Key == "" {
			t.Fatal("closed set not observed exactly once", out, err)
		}
	}
	if !reflect.DeepEqual(before, entries) {
		t.Fatal("qualification changed original bytes")
	}
}

func TestSettledInspectionPureSelectionRefusals(t *testing.T) {
	for _, name := range []string{"empty", "one", "three", "129", "duplicate", "key", "digest", "digest-uppercase", "owner", "profile", "computer", "scope", "origin", "empty-selection"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, _ := settledPureFixture(t)
			switch name {
			case "empty":
				expected = nil
			case "one":
				expected = expected[:1]
			case "three":
				expected = append(expected, expected[0])
			case "129":
				expected = make([]ExpectedSettledRecord, 129)
			case "duplicate":
				expected[1] = expected[0]
			case "key":
				expected[0].Key = strings.Repeat("0", 64) + ".json"
			case "digest":
				expected[0].SHA256 = "bad"
			case "digest-uppercase":
				expected[0].SHA256 = strings.Repeat("A", 64)
			case "owner":
				selection.OwnerID += "2"
			case "profile":
				selection.ProfileID += "2"
			case "computer":
				selection.ComputerID += "2"
			case "scope":
				expected[0].Binding.Identity.Scope = domain.ScopeOwnerSettings
			case "origin":
				expected[0].Binding.Connector.CallID = ""
			case "empty-selection":
				selection = SettledSelection{}
			}
			if _, err := selectSettled(selection, expected); err == nil {
				t.Fatal("invalid selection accepted")
			}
		})
	}
	selection, expected, _ := settledPureFixture(t)
	closed := settledPureSelection(t, selection, expected)
	expected[0].Binding.Connector.CallID = "caller-changed"
	if closed[0].Binding.Connector.CallID == "caller-changed" || closed[1].Binding.Connector.CallID == "caller-changed" {
		t.Fatal("selection retained a mutable caller slice")
	}
}

func TestSettledInspectionPureCanonicalAndInventoryRefusals(t *testing.T) {
	for _, name := range []string{"empty", "missing", "extra", "duplicate", "staging", "wrong-filename", "swapped-bytes", "malformed", "oversize", "whitespace", "duplicate-json", "missing-origin", "unknown-field", "receipt-path", "receipt-operation", "changed-binding", "changed-origin", "changed-outcome", "prepared", "failed", "outcome_unknown", "owner-codec", "task-codec", "process-codec", "write-replacements", "edit-replacements"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, entries := settledPureFixture(t)
			closed := settledPureSelection(t, selection, expected)
			switch name {
			case "empty":
				entries = nil
			case "missing":
				entries = entries[:1]
			case "extra":
				entries = append(entries, settledBytes{key: "unexpected"})
			case "duplicate":
				entries[1] = entries[0]
			case "staging":
				entries[0].key = ".unknown.tmp"
			case "wrong-filename":
				entries[0].key = strings.Repeat("0", 64) + ".json"
			case "swapped-bytes":
				entries[0].raw, entries[1].raw = entries[1].raw, entries[0].raw
			case "malformed":
				entries[0].raw = []byte("{")
			case "oversize":
				entries[0].raw = bytes.Repeat([]byte("x"), maxRecordBytes+1)
			case "whitespace":
				entries[0].raw = append(entries[0].raw, ' ')
			case "duplicate-json":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"schemaVersion":3`), []byte(`"schemaVersion":3,"schemaVersion":3`), 1)
			case "missing-origin":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"callId":"write-call",`), nil, 1)
			case "unknown-field":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"schemaVersion":3`), []byte(`"schemaVersion":3,"extra":true`), 1)
			case "receipt-path":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"operation":"write","relativePath":"write.md"`), []byte(`"operation":"write","relativePath":"wrong.md"`), 1)
			case "receipt-operation":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"kind":"workspace.mutation","operation":"write"`), []byte(`"kind":"workspace.mutation","operation":"edit"`), 1)
			case "changed-binding":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"computerGeneration":7`), []byte(`"computerGeneration":8`), 1)
			case "changed-origin":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"callId":"write-call"`), []byte(`"callId":"changed"`), 1)
			case "changed-outcome":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"bytes":12`), []byte(`"bytes":13`), 1)
			case "prepared", "failed", "outcome_unknown":
				state, err := domain.NewPrepared(expected[0].Binding)
				if err != nil {
					t.Fatal(err)
				}
				if name != "prepared" {
					f := domain.Failure{Code: "WORKSPACE_HELPER_FAILED", Source: "native-workspace"}
					if name == "outcome_unknown" {
						f.Code = "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"
					}
					state, err = state.Refuse(f)
					if err != nil {
						t.Fatal(err)
					}
				}
				entries[0].raw, err = encode(state)
				if err != nil {
					t.Fatal(err)
				}
			case "owner-codec":
				_, _, s := ownerFixture(t)
				entries[0].raw, _ = encode(completed(t, s))
			case "task-codec":
				_, _, s := fixture()
				entries[0].raw, _ = encode(completed(t, s))
			case "process-codec":
				_, _, scope, intent := processFixture()
				var err error
				entries[0].raw, err = encodeProcess(scope, intent)
				if err != nil {
					t.Fatal(err)
				}
			case "write-replacements":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"replacements":0`), []byte(`"replacements":1`), 1)
			case "edit-replacements":
				entries[1].raw = bytes.Replace(entries[1].raw, []byte(`"replacements":1`), []byte(`"replacements":0`), 1)
			}
			// Rebind only the digest, so corrupt/unknown records cannot pass just
			// because their hash was independently selected by the caller.
			for n := range closed {
				for _, e := range entries {
					if e.key == closed[n].Key && name != "changed-outcome" {
						hash := sha256.Sum256(e.raw)
						closed[n].SHA256 = hex.EncodeToString(hash[:])
					}
				}
			}
			visits := 0
			o := &settledPureObservation{entries: entries}
			if out, err := observeSettled(context.Background(), closed, o, func(SettledInspection) error { visits++; return nil }); err == nil || out != nil || visits != 0 {
				t.Fatal("unsafe set reached visitor", out, err, visits)
			}
		})
	}
}

func TestSettledInspectionPureVisitorAndRecheckFences(t *testing.T) {
	for _, name := range []string{"inventory-error", "precheck-error", "postcheck-error", "cancel-before", "cancel-in-inventory", "cancel-before-visitor", "late-visitor", "callback-refusal"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, entries := settledPureFixture(t)
			closed := settledPureSelection(t, selection, expected)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			o := &settledPureObservation{entries: entries}
			if name == "inventory-error" {
				o.inventoryErr = errors.New("private diagnostic")
			}
			if name == "cancel-before" {
				cancel()
			}
			if name == "cancel-in-inventory" {
				o.onInventory = cancel
			}
			o.check = func(n int) error {
				if name == "cancel-before-visitor" && n == 1 {
					cancel()
				}
				if name == "precheck-error" && n == 1 || name == "postcheck-error" && n == 2 {
					return errors.New("private diagnostic")
				}
				return nil
			}
			visits := 0
			out, err := observeSettled(ctx, closed, o, func(SettledInspection) error {
				visits++
				if name == "late-visitor" {
					cancel()
				}
				if name == "callback-refusal" {
					return errors.New("private callback diagnostic")
				}
				return nil
			})
			if err == nil || out != nil || strings.Contains(err.Error(), "private") {
				t.Fatal("failed/late observation accepted or diagnostic leaked", out, err)
			}
			if name == "late-visitor" || name == "callback-refusal" || name == "postcheck-error" {
				if visits != 1 || o.rechecks != 2 {
					t.Fatal("callback skipped, repeated or trusted without fresh check")
				}
			} else if visits != 0 {
				t.Fatal("failed initial observation reached callback")
			}
		})
	}
}

func TestSettledInspectionPureInvalidInputsNeverOpen(t *testing.T) {
	selection, expected, _ := settledPureFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	root := Root{Path: "/private/tmp/not-opened", Device: 1, Inode: 2}
	for _, current := range []context.Context{nil, ctx} {
		if out, err := InspectSettled(current, root, selection, expected, func(SettledInspection) error { t.Fatal("visitor called"); return nil }); err == nil || out != nil {
			t.Fatal("invalid context accepted")
		}
	}
	if out, err := InspectSettled(context.Background(), Root{}, selection, expected, func(SettledInspection) error { t.Fatal("visitor called"); return nil }); err == nil || out != nil {
		t.Fatal("invalid root accepted")
	}
	if out, err := InspectSettled(context.Background(), root, selection, expected, nil); err == nil || out != nil {
		t.Fatal("nil callback accepted")
	}
}
