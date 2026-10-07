package mutation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// This prerequisite deliberately supports exactly two retained records, a
// stricter closed set than a general 128-record inventory. Byte bounds and
// canonical decoding remain owned by the existing repository codec.
const settledRecordCount = 2

// SettledSelection is an expected binding supplied by trusted composition.
// Neither selection nor observed journal metadata conveys authority.
type SettledSelection struct {
	OwnerID, ProfileID, ComputerID string
}

// ExpectedSettledRecord binds an independently selected canonical filename and
// digest of the complete stored bytes to the full immutable connector binding.
// The journal is never used to discover or expand this expected set.
type ExpectedSettledRecord struct {
	Key, SHA256 string
	Binding     domain.Binding
}

type SettledRetainedRecord struct {
	Key, SHA256 string
	Identity    domain.Identity
}

// SettledInspection contains observations only, with no body, prompt, recovered
// State, execution permit, retirement receipt or maintenance authorization.
// Retained is sorted by canonical key and copied by value to the visitor.
type SettledInspection struct {
	Root                            Root
	MutationsDevice, MutationsInode uint64
	LockDevice, LockInode           uint64
	Retained                        [settledRecordCount]SettledRetainedRecord
}

// InspectSettled observes an existing CLOSED store under its existing exclusive
// nonblocking writer lock. Only exactly selected canonical v3 connector workspace
// Completed receipts qualify; Prepared, Failed, unknown and process records refuse.
// It creates, replaces, syncs and deletes nothing. InspectEmpty is independent.
//
// visit is required, trusted, synchronous observation code. It is called once,
// after the entire set qualifies, while all pins and the writer lock remain held.
// It must honor ctx, return normally, and neither mutate journals nor launch or
// defer work, acquire another journal writer, or reenter owner locks. No writer,
// descriptor, mutable record bytes or continuation is handed to it. A callback
// error is classified and never treated as recovery authority. Success is returned
// only after a fresh exact-byte, namespace and physical recheck following visit.
// Cancellation (including a late return after deadline) refuses without replay.
// This cannot sandbox arbitrary trusted callback code or interrupt a stuck visitor.
// The flock excludes cooperating writers only; pinned observations detect changes
// but do not promise atomic isolation from same-user writers ignoring that lock.
func InspectSettled(ctx context.Context, root Root, selection SettledSelection, expected []ExpectedSettledRecord, visit func(SettledInspection) error) (*SettledInspection, error) {
	if ctx == nil || ctx.Err() != nil || !validRoot(root) || visit == nil {
		return nil, unavailable()
	}
	closed, err := selectSettled(selection, expected)
	if err != nil {
		return nil, err
	}
	return inspectSettledExisting(ctx, root, closed, visit)
}

func settledRefusal() error { return failure("COMPUTER_MUTATION_STORE_NOT_SETTLED") }

func selectSettled(selection SettledSelection, expected []ExpectedSettledRecord) ([settledRecordCount]ExpectedSettledRecord, error) {
	var closed [settledRecordCount]ExpectedSettledRecord
	if !domain.Identifier(selection.OwnerID, 160) || !domain.Identifier(selection.ProfileID, 160) || !domain.Identifier(selection.ComputerID, 160) || len(expected) != len(closed) {
		return closed, settledRefusal()
	}
	copy(closed[:], expected)
	for _, e := range closed {
		i := e.Binding.Identity
		key, err := recordKey(i)
		if err != nil || i.Scope != domain.ScopeConnector || i.OwnerID != selection.OwnerID || i.ProfileID != selection.ProfileID || i.ComputerID != selection.ComputerID || key != e.Key || !domain.SHA256(e.SHA256) {
			return closed, settledRefusal()
		}
		if _, err := domain.NewPrepared(e.Binding); err != nil {
			return closed, settledRefusal()
		}
	}
	if closed[0].Key == closed[1].Key {
		return closed, settledRefusal()
	}
	if closed[1].Key < closed[0].Key {
		closed[0], closed[1] = closed[1], closed[0]
	}
	return closed, nil
}

type settledBytes struct {
	key string
	raw []byte
}

// Private pure test seam, not a second store. The native observation retains
// descriptors and supplies no write/create/replace/sync/delete methods.
type settledObservation interface {
	inventory() ([]settledBytes, error)
	recheck([]settledBytes) error
	metadata() SettledInspection
}

func qualifySettled(entries []settledBytes, expected [settledRecordCount]ExpectedSettledRecord) ([settledRecordCount]SettledRetainedRecord, error) {
	var retained [settledRecordCount]SettledRetainedRecord
	if len(entries) != len(expected) {
		return retained, settledRefusal()
	}
	// Sort a copy: never reorder or alter the original observation.
	entries = append([]settledBytes(nil), entries...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].key < entries[j].key })
	for n, entry := range entries {
		state, observed, err := qualifySettledRecord(entry, expected[n])
		if err != nil || state.Phase() != domain.Completed || !completedSettledReceipt(state) {
			return retained, settledRefusal()
		}
		retained[n] = observed
	}
	return retained, nil
}

func qualifySettledRecord(entry settledBytes, expected ExpectedSettledRecord) (*domain.State, SettledRetainedRecord, error) {
	state, err := decode(entry.raw)
	if err != nil || state == nil || state.Binding() != expected.Binding || entry.key != expected.Key {
		return nil, SettledRetainedRecord{}, settledRefusal()
	}
	key, err := recordKey(state.Binding().Identity)
	digest := sha256.Sum256(entry.raw)
	observed := hex.EncodeToString(digest[:])
	if err != nil || key != entry.key || observed != expected.SHA256 {
		return nil, SettledRetainedRecord{}, settledRefusal()
	}
	return state, SettledRetainedRecord{Key: key, SHA256: observed, Identity: state.Binding().Identity}, nil
}

func completedSettledReceipt(state *domain.State) bool {
	receipt := state.Receipt()
	return receipt != nil && (receipt.Operation == domain.WriteKind && receipt.Replacements == 0 || receipt.Operation == domain.EditKind && receipt.Replacements > 0)
}

func observeSettled(ctx context.Context, expected [settledRecordCount]ExpectedSettledRecord, observation settledObservation, visit func(SettledInspection) error) (*SettledInspection, error) {
	if visit == nil {
		return nil, unavailable()
	}
	var retained [settledRecordCount]SettledRetainedRecord
	var result SettledInspection
	err := observeSettledRecords(ctx, observation, func(entries []settledBytes) (err error) {
		retained, err = qualifySettled(entries, expected)
		return err
	}, func(meta SettledInspection) error {
		result = meta
		result.Retained = retained
		return visit(result)
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// Both closed inspectors use one observation lifecycle; their exact selection
// cardinality and terminal policies remain separate.
func observeSettledRecords(ctx context.Context, observation settledObservation, qualify func([]settledBytes) error, visit func(SettledInspection) error) error {
	if ctx == nil || ctx.Err() != nil || observation == nil || qualify == nil || visit == nil {
		return unavailable()
	}
	entries, err := observation.inventory()
	if err != nil || ctx.Err() != nil {
		return unavailable()
	}
	if err := qualify(entries); err != nil {
		return err
	}
	if observation.recheck(entries) != nil || ctx.Err() != nil {
		return unavailable()
	}
	result := observation.metadata()
	if ctx.Err() != nil {
		return unavailable()
	}
	visitErr := visit(result)
	// Even a refused or late visitor is followed by the complete fresh check;
	// its return value cannot stand in for journal qualification.
	checkErr := observation.recheck(entries)
	if checkErr != nil || ctx.Err() != nil {
		return unavailable()
	}
	if visitErr != nil {
		return failure("COMPUTER_MUTATION_INSPECTION_CALLBACK_REFUSED")
	}
	return nil
}
