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

// Pure synthetic canonical records. No native constructor, files, processes,
// installed profile, authority, recovery, terminal or cleanup proof is used.
func preservedPureFixture(t *testing.T) (SettledSelection, []ExpectedPreservedRecord, []settledBytes) {
	t.Helper()
	selection, settled, entries := settledPureFixture(t)
	binding := settled[0].Binding
	binding.Identity.OperationID = "failed-op"
	failed, err := domain.Restore(binding, domain.Failed, nil, &domain.Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := encode(failed)
	if err != nil {
		t.Fatal(err)
	}
	key, err := recordKey(binding.Identity)
	if err != nil {
		t.Fatal(err)
	}
	entries = append(entries, settledBytes{key: key, raw: raw})
	_, _, scope, intent := processFixture()
	raw, err = encodeProcess(scope, intent)
	if err != nil {
		t.Fatal(err)
	}
	key, err = recordKey(processIdentity(scope, intent.OperationID))
	if err != nil {
		t.Fatal(err)
	}
	entries = append(entries, settledBytes{key: key, raw: raw})
	expected := []ExpectedPreservedRecord{
		{Identity: settled[0].Binding.Identity}, {Identity: settled[1].Binding.Identity},
		{Identity: binding.Identity}, {Identity: processIdentity(scope, intent.OperationID)},
	}
	for n, entry := range entries {
		expected[n].Key = entry.key
		expected[n].SHA256 = preservedDigest(entry.raw)
	}
	return selection, expected, entries
}

func preservedDigest(raw []byte) string {
	hash := sha256.Sum256(raw)
	return hex.EncodeToString(hash[:])
}

func preservedPureSelection(t *testing.T, selection SettledSelection, expected []ExpectedPreservedRecord) []ExpectedPreservedRecord {
	t.Helper()
	closed, err := selectPreserved(selection, expected)
	if err != nil {
		t.Fatal(err)
	}
	return closed
}

func TestPreservedInspectionPureMixedMetadataAndCopy(t *testing.T) {
	selection, expected, entries := preservedPureFixture(t)
	closed := preservedPureSelection(t, selection, expected)
	original := make([]settledBytes, len(entries))
	for n, e := range entries {
		original[n] = settledBytes{key: e.key, raw: bytes.Clone(e.raw)}
	}
	o := &settledPureObservation{entries: entries}
	visits := 0
	out, err := observePreserved(context.Background(), closed, o, func(meta PreservedInspection) error {
		visits++
		if o.rechecks != 1 || meta.ReservedProcesses != 1 || len(meta.Retained) != len(closed) || meta.Root != o.metadata().Root || meta.LockInode != 4 || meta.MutationsInode != 3 {
			t.Fatal("incomplete qualified metadata")
		}
		for n, record := range meta.Retained {
			if record != (SettledRetainedRecord{Key: closed[n].Key, SHA256: closed[n].SHA256, Identity: closed[n].Identity}) {
				t.Fatal("identity or complete-byte digest lost")
			}
		}
		meta.Retained[0] = SettledRetainedRecord{}
		meta.Retained = append(meta.Retained, SettledRetainedRecord{})
		meta.ReservedProcesses = 0
		expected[0] = ExpectedPreservedRecord{}
		return nil
	})
	if err != nil || out == nil || visits != 1 || o.inventories != 1 || o.rechecks != 2 || out.ReservedProcesses != 1 || len(out.Retained) != 4 || out.Retained[0].Key == "" {
		t.Fatal("metadata aliases visitor or selection", err)
	}
	if !reflect.DeepEqual(original, entries) {
		t.Fatal("qualification changed records")
	}
	// Public metadata is closed and carries no records, bodies or command payload.
	if reflect.TypeFor[PreservedInspection]().NumField() != 7 || reflect.TypeFor[SettledRetainedRecord]().NumField() != 3 {
		t.Fatal("metadata surface expanded")
	}
}

func TestPreservedInspectionPureCardinalityBoundsAndClasses(t *testing.T) {
	selection, expected, entries := preservedPureFixture(t)
	// Every allowed class can be the entire inventory, including one reservation.
	for n := range entries {
		closed := preservedPureSelection(t, selection, expected[n:n+1])
		out, err := observePreserved(context.Background(), closed, &settledPureObservation{entries: entries[n : n+1]}, func(PreservedInspection) error { return nil })
		want := 0
		if n == 3 {
			want = 1
		}
		if err != nil || out == nil || len(out.Retained) != 1 || out.ReservedProcesses != want {
			t.Fatal("single allowed class refused", n, err)
		}
	}
	var fullExpected []ExpectedPreservedRecord
	var fullEntries []settledBytes
	_, _, scope, intent := processFixture()
	for n := 0; n < 128; n++ {
		intent.OperationID = fmt.Sprintf("read-op-%d", n)
		raw, err := encodeProcess(scope, intent)
		if err != nil {
			t.Fatal(err)
		}
		identity := processIdentity(scope, intent.OperationID)
		key, err := recordKey(identity)
		if err != nil {
			t.Fatal(err)
		}
		fullExpected = append(fullExpected, ExpectedPreservedRecord{Key: key, SHA256: preservedDigest(raw), Identity: identity})
		fullEntries = append(fullEntries, settledBytes{key: key, raw: raw})
	}
	closed := preservedPureSelection(t, selection, fullExpected)
	out, err := observePreserved(context.Background(), closed, &settledPureObservation{entries: fullEntries}, func(PreservedInspection) error { return nil })
	if err != nil || out == nil || len(out.Retained) != 128 || out.ReservedProcesses != 128 {
		t.Fatal("maximum bounded set refused", err)
	}
}

func TestPreservedInspectionPureSelectionRefusals(t *testing.T) {
	for _, name := range []string{"zero", "129", "duplicate-key", "duplicate-identity", "key", "digest", "uppercase-digest", "owner", "profile", "computer", "scope", "operation", "legacy-session", "legacy-task", "legacy-epoch", "legacy-participant", "empty-selection", "invalid-owner", "invalid-profile", "invalid-computer"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, _ := preservedPureFixture(t)
			switch name {
			case "zero":
				expected = nil
			case "129":
				expected = make([]ExpectedPreservedRecord, 129)
			case "duplicate-key":
				expected[1].Key = expected[0].Key
			case "duplicate-identity":
				expected[1] = expected[0]
			case "key":
				expected[0].Key = "../unsafe.json"
			case "digest":
				expected[0].SHA256 = "bad"
			case "uppercase-digest":
				expected[0].SHA256 = strings.Repeat("A", 64)
			case "owner":
				selection.OwnerID += "2"
			case "profile":
				selection.ProfileID += "2"
			case "computer":
				selection.ComputerID += "2"
			case "scope":
				expected[0].Identity.Scope = domain.ScopeOwnerSettings
			case "operation":
				expected[0].Identity.OperationID = ""
			case "legacy-session":
				expected[0].Identity.SessionID = "session"
			case "legacy-task":
				expected[0].Identity.TaskID = "task"
			case "legacy-epoch":
				expected[0].Identity.TaskEpoch = 1
			case "legacy-participant":
				expected[0].Identity.ParticipantID = "participant"
			case "empty-selection":
				selection = SettledSelection{}
			case "invalid-owner":
				selection.OwnerID = ""
			case "invalid-profile":
				selection.ProfileID = ""
			case "invalid-computer":
				selection.ComputerID = ""
			}
			if _, err := selectPreserved(selection, expected); err == nil {
				t.Fatal("unsafe selection accepted")
			}
		})
	}
}

func TestPreservedInspectionPureRecordAndNamespaceRefusals(t *testing.T) {
	for _, name := range []string{"empty", "missing", "extra", "129", "duplicate", "staging", "filename", "swapped-bytes", "malformed", "oversize", "invalid-utf8", "whitespace", "duplicate-json", "unknown-field", "missing-origin", "receipt-path", "receipt-operation", "write-replacements", "edit-replacements", "prepared", "outcome-unknown", "unknown-failure-code", "unknown-failure-source", "failed-with-receipt", "v1", "v2", "v5", "process-write", "process-completed", "process-failed", "process-unknown", "process-unknown-field", "process-duplicate-json", "process-whitespace", "process-seal", "identity-operation", "identity-owner", "identity-profile", "identity-computer", "process-operation", "process-owner", "process-profile", "process-computer", "changed-body-digest", "changed-origin-digest", "changed-outcome-digest", "changed-process-digest"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, entries := preservedPureFixture(t)
			switch name {
			case "empty":
				entries = nil
			case "missing":
				entries = entries[:3]
			case "extra":
				entries = append(entries, settledBytes{key: "unexpected"})
			case "129":
				entries = make([]settledBytes, 129)
			case "duplicate":
				entries[1] = entries[0]
			case "staging":
				entries[0].key = ".unknown.tmp"
			case "filename":
				entries[0].key = strings.Repeat("0", 64) + ".json"
			case "swapped-bytes":
				entries[0].raw, entries[1].raw = entries[1].raw, entries[0].raw
			case "malformed":
				entries[0].raw = []byte("{")
			case "oversize":
				entries[0].raw = bytes.Repeat([]byte("x"), maxRecordBytes+1)
			case "invalid-utf8":
				entries[0].raw = []byte{255}
			case "whitespace":
				entries[0].raw = append(entries[0].raw, ' ')
			case "duplicate-json":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"schemaVersion":3`), []byte(`"schemaVersion":3,"schemaVersion":3`), 1)
			case "unknown-field":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"schemaVersion":3`), []byte(`"schemaVersion":3,"extra":true`), 1)
			case "missing-origin":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"callId":"write-call",`), nil, 1)
			case "receipt-path":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"operation":"write","relativePath":"write.md"`), []byte(`"operation":"write","relativePath":"wrong.md"`), 1)
			case "receipt-operation":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"kind":"workspace.mutation","operation":"write"`), []byte(`"kind":"workspace.mutation","operation":"edit"`), 1)
			case "write-replacements":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"replacements":0`), []byte(`"replacements":1`), 1)
			case "edit-replacements":
				entries[1].raw = bytes.Replace(entries[1].raw, []byte(`"replacements":1`), []byte(`"replacements":0`), 1)
			case "prepared", "outcome-unknown":
				state, err := decode(entries[0].raw)
				if err != nil {
					t.Fatal(err)
				}
				phase := domain.Prepared
				var failure *domain.Failure
				if name == "outcome-unknown" {
					phase = domain.OutcomeUnknown
					failure = &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
				}
				state, err = domain.Restore(state.Binding(), phase, nil, failure)
				if err != nil {
					t.Fatal(err)
				}
				entries[0].raw, err = encode(state)
				if err != nil {
					t.Fatal(err)
				}
			case "unknown-failure-code":
				entries[2].raw = bytes.Replace(entries[2].raw, []byte("WORKSPACE_MUTATION_CONFLICT"), []byte("INVENTED"), 1)
			case "unknown-failure-source":
				entries[2].raw = bytes.Replace(entries[2].raw, []byte("native-workspace"), []byte("invented"), 1)
			case "failed-with-receipt":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"phase":"completed"`), []byte(`"phase":"failed"`), 1)
			case "v1":
				_, _, state := fixture()
				entries[0].raw, _ = encode(completed(t, state))
			case "v2":
				_, _, state := ownerFixture(t)
				entries[0].raw, _ = encode(completed(t, state))
			case "v5":
				raw, _, err := encodeProcessTerminal(terminalValue(nil, nil))
				if err != nil {
					t.Fatal(err)
				}
				entries[3].raw = raw
			case "process-write":
				_, _, scope, intent := processFixture()
				intent.Seal.Write = true
				raw, err := encodeProcess(scope, intent)
				if err != nil {
					t.Fatal(err)
				}
				entries[3].raw = raw
			case "process-completed", "process-failed", "process-unknown":
				phase := map[string]string{"process-completed": "completed", "process-failed": "failed", "process-unknown": "outcome_unknown"}[name]
				entries[3].raw = bytes.Replace(entries[3].raw, []byte(`"phase":"reserved"`), []byte(`"phase":"`+phase+`"`), 1)
			case "process-unknown-field":
				entries[3].raw = bytes.Replace(entries[3].raw, []byte(`"schemaVersion":4`), []byte(`"schemaVersion":4,"extra":true`), 1)
			case "process-duplicate-json":
				entries[3].raw = bytes.Replace(entries[3].raw, []byte(`"schemaVersion":4`), []byte(`"schemaVersion":4,"schemaVersion":4`), 1)
			case "process-whitespace":
				entries[3].raw = append(entries[3].raw, ' ')
			case "process-seal":
				entries[3].raw = bytes.Replace(entries[3].raw, []byte(`"cwd":"/workspace/code/sub"`), []byte(`"cwd":"/outside"`), 1)
			case "identity-operation":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"operationId":"write-op"`), []byte(`"operationId":"other-op"`), 1)
			case "identity-owner":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"ownerId":"owner"`), []byte(`"ownerId":"other"`), 1)
			case "identity-profile":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"profileId":"profile"`), []byte(`"profileId":"other"`), 1)
			case "identity-computer":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"computerId":"computer"`), []byte(`"computerId":"other"`), 1)
			case "process-operation":
				entries[3].raw = bytes.Replace(entries[3].raw, []byte(`"operationId":"op"`), []byte(`"operationId":"other"`), 1)
			case "process-owner":
				entries[3].raw = bytes.ReplaceAll(entries[3].raw, []byte(`"ownerId":"owner"`), []byte(`"ownerId":"other"`))
			case "process-profile":
				entries[3].raw = bytes.Replace(entries[3].raw, []byte(`"profileId":"profile"`), []byte(`"profileId":"other"`), 1)
			case "process-computer":
				entries[3].raw = bytes.Replace(entries[3].raw, []byte(`"computerId":"computer"`), []byte(`"computerId":"other"`), 1)
			case "changed-body-digest":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"relativePath":"write.md"`), []byte(`"relativePath":"other.md"`), -1)
			case "changed-origin-digest":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"callId":"write-call"`), []byte(`"callId":"other-call"`), 1)
			case "changed-outcome-digest":
				entries[0].raw = bytes.Replace(entries[0].raw, []byte(`"bytes":12`), []byte(`"bytes":13`), 1)
			case "changed-process-digest":
				entries[3].raw = bytes.Replace(entries[3].raw, []byte(`"callId":"call"`), []byte(`"callId":"other"`), 1)
			}
			// Select all changed bytes except digest-binding cases. Canonical corruption,
			// excluded classes and identity mismatches must still refuse independently.
			if !strings.HasSuffix(name, "-digest") {
				for n := range expected {
					for _, entry := range entries {
						if entry.key == expected[n].Key {
							expected[n].SHA256 = preservedDigest(entry.raw)
						}
					}
				}
			}
			closed := preservedPureSelection(t, selection, expected)
			visits := 0
			out, err := observePreserved(context.Background(), closed, &settledPureObservation{entries: entries}, func(PreservedInspection) error { visits++; return nil })
			if err == nil || out != nil || visits != 0 {
				t.Fatal("unqualified set reached visitor", name, err)
			}
		})
	}
}

func TestPreservedInspectionPureLifecycleRefusals(t *testing.T) {
	for _, name := range []string{"inventory-error", "cancel-inventory", "precheck-error", "cancel-precheck", "callback-error", "cancel-visitor", "postcheck-error", "cancel-postcheck", "callback-mutation-and-error", "callback-mutation-and-cancel"} {
		t.Run(name, func(t *testing.T) {
			selection, expected, entries := preservedPureFixture(t)
			closed := preservedPureSelection(t, selection, expected)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			o := &settledPureObservation{entries: entries}
			if name == "inventory-error" {
				o.inventoryErr = errors.New("private inventory")
			}
			if name == "cancel-inventory" {
				o.onInventory = cancel
			}
			mutated := false
			o.check = func(n int) error {
				if name == "cancel-precheck" && n == 1 || name == "cancel-postcheck" && n == 2 {
					cancel()
				}
				if name == "precheck-error" && n == 1 || name == "postcheck-error" && n == 2 || mutated {
					return errors.New("private check")
				}
				return nil
			}
			visits := 0
			out, err := observePreserved(ctx, closed, o, func(PreservedInspection) error {
				visits++
				if strings.HasPrefix(name, "callback-mutation") {
					mutated = true
					entries[0].raw = []byte("changed")
				}
				if name == "cancel-visitor" || name == "callback-mutation-and-cancel" {
					cancel()
				}
				if name == "callback-error" || name == "callback-mutation-and-error" {
					return errors.New("private callback")
				}
				return nil
			})
			if err == nil || out != nil || strings.Contains(err.Error(), "private") {
				t.Fatal("failed observation accepted or diagnostic leaked", err)
			}
			afterVisitor := name == "callback-error" || name == "cancel-visitor" || name == "postcheck-error" || name == "cancel-postcheck" || strings.HasPrefix(name, "callback-mutation")
			if afterVisitor && (visits != 1 || o.rechecks != 2) {
				t.Fatal("final check skipped or visitor replayed")
			}
			if !afterVisitor && visits != 0 {
				t.Fatal("early refusal reached visitor")
			}
			if mutated {
				code(t, err, "COMPUTER_MUTATION_STORE_UNAVAILABLE")
			}
		})
	}
}

func TestPreservedInspectionPureInvalidInputsNeverOpen(t *testing.T) {
	selection, expected, _ := preservedPureFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	root := Root{Path: "/private/tmp/not-opened", Device: 1, Inode: 2}
	visitor := func(PreservedInspection) error { t.Fatal("invalid input reached visitor"); return nil }
	for _, ctx := range []context.Context{nil, ctx} {
		if out, err := InspectPreserved(ctx, root, selection, expected, visitor); err == nil || out != nil {
			t.Fatal("invalid context accepted")
		}
	}
	if out, err := InspectPreserved(context.Background(), Root{}, selection, expected, visitor); err == nil || out != nil {
		t.Fatal("invalid root accepted")
	}
	if out, err := InspectPreserved(context.Background(), root, selection, expected, nil); err == nil || out != nil {
		t.Fatal("nil visitor accepted")
	}
	if out, err := observePreserved(context.Background(), expected, nil, visitor); err == nil || out != nil {
		t.Fatal("nil observation accepted")
	}
	if out, err := observePreserved(context.Background(), expected, &settledPureObservation{}, nil); err == nil || out != nil {
		t.Fatal("nil visitor accepted by observation")
	}
	if out, err := InspectPreserved(context.Background(), root, selection, nil, visitor); err == nil || out != nil {
		t.Fatal("empty selection accepted")
	}
}
