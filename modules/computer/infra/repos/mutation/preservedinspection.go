package mutation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

const maxPreservedRecords = 128

// ExpectedPreservedRecord independently binds the full immutable identity,
// canonical filename and digest of all stored bytes. The journal never expands it.
type ExpectedPreservedRecord struct {
	Key, SHA256 string
	Identity    domain.Identity
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
// or Failed (known failure codec) records and canonical v4 connector process
// read-only reservations (Seal.Write == false) qualify. Prepared, outcome-unknown
// file mutations, v1/v2/v5, staging, unknown files and mismatched identity or bytes
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
		if err != nil || i.Scope != domain.ScopeConnector || i.OwnerID != selection.OwnerID || i.ProfileID != selection.ProfileID || i.ComputerID != selection.ComputerID || key != e.Key || !domain.SHA256(e.SHA256) || identities[i] {
			return nil, preservedRefusal()
		}
		identities[i] = true
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
	refuse := func() (SettledRetainedRecord, bool, error) { return SettledRetainedRecord{}, false, preservedRefusal() }
	if entry.key != expected.Key || len(entry.raw) < 1 || len(entry.raw) > maxRecordBytes {
		return refuse()
	}
	digest := sha256.Sum256(entry.raw)
	observed := hex.EncodeToString(digest[:])
	if observed != expected.SHA256 {
		return refuse()
	}
	// Explicit closed schema dispatch: no historical or terminal-process fallback.
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
	default:
		return refuse()
	}
	key, err := recordKey(identity)
	if err != nil || identity != expected.Identity || identity.Scope != domain.ScopeConnector || key != entry.key {
		return refuse()
	}
	return SettledRetainedRecord{Key: key, SHA256: observed, Identity: identity}, reserved, nil
}

func qualifyPreserved(entries []settledBytes, expected []ExpectedPreservedRecord) ([]SettledRetainedRecord, int, error) {
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
		observed, process, err := qualifyPreservedRecord(entry, expected[n])
		if err != nil {
			return nil, 0, err
		}
		retained[n] = observed
		if process {
			reserved++
		}
	}
	return retained, reserved, nil
}

func observePreserved(ctx context.Context, expected []ExpectedPreservedRecord, observation settledObservation, visit func(PreservedInspection) error) (*PreservedInspection, error) {
	if visit == nil {
		return nil, unavailable()
	}
	var result PreservedInspection
	err := observeSettledRecords(ctx, observation, func(entries []settledBytes) (err error) {
		result.Retained, result.ReservedProcesses, err = qualifyPreserved(entries, expected)
		return err
	}, func(meta SettledInspection) error {
		result.Root, result.MutationsDevice, result.MutationsInode = meta.Root, meta.MutationsDevice, meta.MutationsInode
		result.LockDevice, result.LockInode = meta.LockDevice, meta.LockInode
		copied := result
		copied.Retained = append([]SettledRetainedRecord(nil), result.Retained...)
		return visit(copied)
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}
