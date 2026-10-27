package mutation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

const maxPreservedRecords = 128

// ExpectedPreservedRecord independently binds the full immutable identity,
// canonical filename and digest of all stored bytes. The journal never expands it.
type ExpectedPreservedRecord struct {
	Key, SHA256 string
	// OutputParent binds a chunk to an independently selected process result.
	// Empty preserves the original per-operation selection contract.
	OutputParent string `json:",omitempty"`
	Identity     domain.Identity
}

// PreservedInspection contains storage observations only. ReservedProcesses
// counts reservations whose execution outcome remains unknown; it conveys no
// terminal, cleanup, retry, settlement, recovery, retirement or maintenance authority.
// Retained is sorted by key and separately copied for the synchronous visitor.
type PreservedInspection struct {
	Root                            Root
	MutationsDevice, MutationsInode uint64
	LockDevice, LockInode           uint64
	Retained                        []SettledRetainedRecord
	ReservedProcesses               int
}

// InspectPreserved observes an existing exact independently selected 1..128
// record namespace. Only canonical v3 connector file Completed (valid receipt)
// or Failed (known failure codec) records, canonical v4 read-only reservations,
// and canonical v6 known supervisor-exit results with their complete v5 output
// publications qualify. Cleanup uncertainty remains unchanged. Prepared, unknown
// file mutations, write-capable reservations, staging and mismatched identity or bytes
// refuse. Preserving reservations supplies no terminal or cleanup claim.
//
// This is storage observation only, NEVER settlement or recovery authority.
// It creates, writes, replaces, syncs and deletes nothing. The existing exclusive
// nonblocking writer lock and all physical descriptors remain pinned throughout
// the required trusted synchronous visitor and the full final recheck, including
// visitor failure or cancellation. The visitor receives safe metadata only,
// without commands, bodies, raw records, writers, permits or continuations.
// InspectSettled's callback non-reentry and cooperative-lock limits also apply:
// visitors must return normally and honor ctx; they cannot be forcibly interrupted.
// A reservation stays reserved/unknown and never authorizes replay or execution.
func InspectPreserved(ctx context.Context, root Root, selection SettledSelection, expected []ExpectedPreservedRecord, visit func(PreservedInspection) error) (*PreservedInspection, error) {
	if ctx == nil || ctx.Err() != nil || !validRoot(root) || visit == nil {
		return nil, unavailable()
	}
	closed, err := selectPreserved(selection, expected)
	if err != nil {
		return nil, err
	}
	return inspectPreservedExisting(ctx, root, closed, visit)
}

func preservedRefusal() error { return failure("COMPUTER_MUTATION_STORE_NOT_PRESERVED") }

func selectPreserved(selection SettledSelection, expected []ExpectedPreservedRecord) ([]ExpectedPreservedRecord, error) {
	if !domain.Identifier(selection.OwnerID, 160) || !domain.Identifier(selection.ProfileID, 160) || !domain.Identifier(selection.ComputerID, 160) || len(expected) < 1 || len(expected) > maxPreservedRecords {
		return nil, preservedRefusal()
	}
	closed := append([]ExpectedPreservedRecord(nil), expected...)
	identities := make(map[domain.Identity]bool, len(closed))
	for _, e := range closed {
		i := e.Identity
		key, err := recordKey(i)
		if err != nil || i.Scope != domain.ScopeConnector || i.OwnerID != selection.OwnerID || i.ProfileID != selection.ProfileID || i.ComputerID != selection.ComputerID || !domain.SHA256(e.SHA256) || e.OutputParent == "" && (key != e.Key || identities[i]) || e.OutputParent != "" && (key != e.OutputParent || !validProcessParent(e.Key)) {
			return nil, preservedRefusal()
		}
		if e.OutputParent == "" {
			identities[i] = true
		}
	}
	sort.Slice(closed, func(i, j int) bool { return closed[i].Key < closed[j].Key })
	for n := 1; n < len(closed); n++ {
		if closed[n-1].Key == closed[n].Key {
			return nil, preservedRefusal()
		}
	}
	return closed, nil
}

func qualifyPreservedRecord(entry settledBytes, expected ExpectedPreservedRecord) (SettledRetainedRecord, bool, error) {
	return qualifyPreservedRecordPolicy(entry, expected, false)
}

func qualifyPreservedRecordPolicy(entry settledBytes, expected ExpectedPreservedRecord, machineRestartObserved bool) (SettledRetainedRecord, bool, error) {
	refuse := func() (SettledRetainedRecord, bool, error) { return SettledRetainedRecord{}, false, preservedRefusal() }
	if entry.key != expected.Key || len(entry.raw) < 1 || len(entry.raw) > maxRecordBytes {
		return refuse()
	}
	digest := sha256.Sum256(entry.raw)
	observed := hex.EncodeToString(digest[:])
	if observed != expected.SHA256 {
		return refuse()
	}
	// Explicit canonical dispatch. Stored process results are preserved as results,
	// never upgraded to descendant cleanup or settlement authority.
	var header struct {
		Version uint8           `json:"schemaVersion"`
		Kind    string          `json:"kind"`
		Record  json.RawMessage `json:"record"`
	}
	if decodeStrict(entry.raw, &header) != nil {
		return refuse()
	}
	var identity domain.Identity
	reserved := false
	output := false
	switch {
	case header.Version == 3 && header.Kind == "workspace_connector_mutation":
		state, err := decode(entry.raw)
		if err != nil || state == nil {
			return refuse()
		}
		switch state.Phase() {
		case domain.Completed:
			if !completedSettledReceipt(state) {
				return refuse()
			}
		case domain.Failed:
			// decode/Restore already enforce the closed known-failure vocabulary,
			// no receipt, and the exclusion of outcome-unknown failure codes.
			if state.Failure() == nil || state.Receipt() != nil {
				return refuse()
			}
		default:
			return refuse()
		}
		identity = state.Binding().Identity
	case header.Version == 4 && header.Kind == "workspace_connector_process":
		scope, intent, err := decodeProcess(entry.raw)
		if err != nil || intent.Seal.Write {
			return refuse()
		}
		identity = processIdentity(scope, intent.OperationID)
		reserved = true
	case header.Version == 6 && header.Kind == "workspace_connector_process_terminal":
		result, _, err := decodeProcessTerminal(entry.raw)
		if err != nil || result == nil || result.Observation.Supervisor != processsvc.SupervisorExited ||
			result.Intent.Seal.Write && !machineRestartObserved && (result.Observation.GroupCleanup != processsvc.CleanupConfirmed || result.Observation.DescendantCleanup != processsvc.CleanupConfirmed) {
			return refuse()
		}
		// Read-only root results retain cleanup uncertainty. Write-capable
		// results need positive group/descendant cleanup or independently observed
		// machine exclusion. An exited supervisor alone does not exclude old writes.
		identity = processIdentity(result.Scope, result.Intent.OperationID)
	case header.Version == 5 && header.Kind == "workspace_connector_process_output":
		var envelope processOutputEnvelope
		if decodeStrict(entry.raw, &envelope) != nil || expected.OutputParent == "" {
			return refuse()
		}
		r := envelope.Record
		d := processOutputDigest{Offset: r.Offset, Bytes: uint32(len(r.Data)), SHA256: r.SHA256}
		if r.Parent != expected.OutputParent || processOutputKey(r.Parent, r.Stream, d) != entry.key {
			return refuse()
		}
		if _, err := decodeProcessOutput(entry.raw, r.Parent, r.Stream, d); err != nil {
			return refuse()
		}
		identity, output = expected.Identity, true
	default:
		return refuse()
	}
	key, err := recordKey(identity)
	if err != nil || identity != expected.Identity || identity.Scope != domain.ScopeConnector || (output && key != expected.OutputParent || !output && (key != entry.key || expected.OutputParent != "")) {
		return refuse()
	}
	return SettledRetainedRecord{Key: entry.key, SHA256: observed, Identity: identity}, reserved, nil
}

func qualifyPreserved(entries []settledBytes, expected []ExpectedPreservedRecord) ([]SettledRetainedRecord, int, error) {
	return qualifyPreservedPolicy(entries, expected, false)
}

func qualifyPreservedPolicy(entries []settledBytes, expected []ExpectedPreservedRecord, machineRestartObserved bool) ([]SettledRetainedRecord, int, error) {
	if len(expected) < 1 || len(expected) > maxPreservedRecords || len(entries) != len(expected) {
		return nil, 0, preservedRefusal()
	}
	entries = append([]settledBytes(nil), entries...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].key < entries[j].key })
	retained := make([]SettledRetainedRecord, len(entries))
	reserved := 0
	for n, entry := range entries {
		if n > 0 && entries[n-1].key == entry.key {
			return nil, 0, preservedRefusal()
		}
		observed, process, err := qualifyPreservedRecordPolicy(entry, expected[n], machineRestartObserved)
		if err != nil {
			return nil, 0, err
		}
		retained[n] = observed
		if process {
			reserved++
		}
	}
	if err := qualifyPreservedProcessOutputs(entries, expected); err != nil {
		return nil, 0, err
	}
	return retained, reserved, nil
}

func observePreserved(ctx context.Context, expected []ExpectedPreservedRecord, observation settledObservation, visit func(PreservedInspection) error) (*PreservedInspection, error) {
	if visit == nil {
		return nil, unavailable()
	}
	return observePreservedPolicy(ctx, expected, observation, visit, nil)
}

func observePreservedPolicy(ctx context.Context, expected []ExpectedPreservedRecord, observation settledObservation, visit func(PreservedInspection) error, verifyMachineRestart func() error) (*PreservedInspection, error) {
	if verifyMachineRestart != nil && verifyMachineRestart() != nil {
		return nil, unavailable()
	}
	var result PreservedInspection
	err := observeSettledRecords(ctx, observation, func(entries []settledBytes) (err error) {
		result.Retained, result.ReservedProcesses, err = qualifyPreservedPolicy(entries, expected, verifyMachineRestart != nil)
		return err
	}, func(meta SettledInspection) error {
		if verifyMachineRestart != nil && verifyMachineRestart() != nil {
			return unavailable()
		}
		result.Root, result.MutationsDevice, result.MutationsInode = meta.Root, meta.MutationsDevice, meta.MutationsInode
		result.LockDevice, result.LockInode = meta.LockDevice, meta.LockInode
		copied := result
		copied.Retained = append([]SettledRetainedRecord(nil), result.Retained...)
		visitErr := visit(copied)
		if verifyMachineRestart != nil && verifyMachineRestart() != nil {
			return unavailable()
		}
		return visitErr
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// Every chunk must be named by exactly one selected result, and every named
// chunk must be selected. Orphans and partial terminal publications refuse.
func qualifyPreservedProcessOutputs(entries []settledBytes, expected []ExpectedPreservedRecord) error {
	return qualifyRetainedProcessOutputs(entries, expected, false)
}

// Original preservation keeps its v6-only policy. Fresh admission can also
// observe canonical v5 cohort results; neither path changes the result or ACK.
func qualifyRetainedProcessOutputs(entries []settledBytes, expected []ExpectedPreservedRecord, legacyCohort bool) error {
	named := make(map[string]string)
	selected := make(map[string]ExpectedPreservedRecord, len(expected))
	for _, e := range expected {
		selected[e.Key] = e
	}
	for _, entry := range entries {
		var header struct {
			Version uint8           `json:"schemaVersion"`
			Kind    string          `json:"kind"`
			Record  json.RawMessage `json:"record"`
		}
		if decodeStrict(entry.raw, &header) != nil {
			return preservedRefusal()
		}
		if (header.Version != 6 && !(legacyCohort && header.Version == 5)) || header.Kind != "workspace_connector_process_terminal" {
			continue
		}
		_, terminal, err := decodeProcessTerminal(entry.raw)
		if err != nil {
			return preservedRefusal()
		}
		for _, stream := range []struct {
			name   string
			chunks []processOutputDigest
		}{{"stdout", terminal.Record.Stdout}, {"stderr", terminal.Record.Stderr}} {
			for _, chunk := range stream.chunks {
				key := processOutputKey(entry.key, stream.name, chunk)
				e, ok := selected[key]
				if !ok || e.OutputParent != entry.key || e.Identity != selected[entry.key].Identity || named[key] != "" {
					return preservedRefusal()
				}
				named[key] = entry.key
				var raw []byte
				for _, candidate := range entries {
					if candidate.key == key {
						raw = candidate.raw
						break
					}
				}
				if _, err := decodeProcessOutput(raw, entry.key, stream.name, chunk); err != nil {
					return preservedRefusal()
				}
			}
		}
	}
	for _, e := range expected {
		if e.OutputParent != "" && named[e.Key] != e.OutputParent {
			return preservedRefusal()
		}
	}
	return nil
}
