package mutation

import (
	"context"
	"sort"
	"time"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// OwnerSelection is an independently selected historical owner/profile/computer
// binding. It conveys no current authority or successor proof.
type OwnerSelection struct {
	OwnerID, ProfileID, ComputerID string
}

// ExpectedOwnerRecord binds a preselected canonical key and full stored-byte
// SHA256 to the complete immutable binding. The journal never expands this set.
type ExpectedOwnerRecord struct {
	Key, SHA256 string
	Binding     domain.Binding
}

// OwnerRetainedRecord is a recorded historical observation only, without mutable
// State, receipt body, ACK, current authority, original process closure or successor proof.
type OwnerRetainedRecord struct {
	Key, SHA256 string
	Identity    domain.Identity
}

// OwnerInspection contains recorded historical observations only, without mutable
// State, receipt body, ACK, current authority, original process closure or successor
// proof. Retained is sorted by key and separately copied for the visitor.
type OwnerInspection struct {
	Root                            Root
	MutationsDevice, MutationsInode uint64
	LockDevice, LockInode           uint64
	Retained                        []OwnerRetainedRecord
}

// InspectOwnerCompleted observes exactly 1..128 independently preselected canonical
// schema2 owner-settings Completed records with valid Write/Edit receipt shapes.
// It opens only existing storage, retaining the original exclusive nonblocking
// mutation lock and pins through the synchronous visitor and final byte, namespace
// and metadata recheck, including visitor failure or cancellation. It creates,
// repairs, syncs, deletes and fences nothing and never opens a mutable owner.
//
// The caller's original absolute deadline is required and captured once before
// native IO. Expiry/cancellation or failed final checks (including cleanup) take
// precedence over the visitor error; otherwise that error is preserved unchanged.
// No failure returns a partial result. The trusted visitor must return normally,
// honor the caller's deadline, remain read-only and not reenter owners, launch or
// defer work. It receives no handles, origins, writer or continuation. A stuck
// visitor cannot be forcibly interrupted. Cooperating writers are excluded;
// same-user writers ignoring the lock are not atomically isolated.
//
// These are recorded historical observations only, with no mutable State/receipt
// body, ACK, current authority, original process closure or successor proof. Root
// composition still owns maintenance/process exclusion and every other profile
// journal. This is no recovery, admission, retirement, replay, relocation, cold-boot,
// cleanup or promotion authority and selects no normal or installed route.
func InspectOwnerCompleted(ctx context.Context, root Root, selection OwnerSelection, expected []ExpectedOwnerRecord, visit func(OwnerInspection) error) (*OwnerInspection, error) {
	bounded, err := boundOwnerInspection(ctx)
	if err != nil || !validRoot(root) || visit == nil {
		return nil, unavailable()
	}
	closed, err := selectOwner(selection, expected)
	if err != nil {
		return nil, err
	}
	result, err := inspectOwnerExisting(bounded, root, closed, visit)
	// The native helper has now closed all retained descriptors and the lock.
	// Check the captured absolute deadline again, even if its timer has lagged.
	if bounded.Err() != nil {
		return nil, unavailable()
	}
	if err != nil {
		return nil, err
	}
	return result, nil
}

// Keep the original absolute bound even for a delayed context timer. All shared
// storage lifecycle checks use this same context; no phase renews its deadline.
type ownerInspectionContext struct {
	context.Context
	deadline time.Time
}

func (c ownerInspectionContext) Deadline() (time.Time, bool) { return c.deadline, true }
func (c ownerInspectionContext) Err() error {
	if err := c.Context.Err(); err != nil {
		return err
	}
	if !time.Now().Before(c.deadline) {
		return context.DeadlineExceeded
	}
	return nil
}

func boundOwnerInspection(ctx context.Context) (context.Context, error) {
	if ctx == nil {
		return nil, unavailable()
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		return nil, unavailable()
	}
	bounded := ownerInspectionContext{Context: ctx, deadline: deadline}
	if bounded.Err() != nil {
		return nil, unavailable()
	}
	return bounded, nil
}

func ownerRefusal() error { return failure("COMPUTER_MUTATION_STORE_NOT_OWNER_COMPLETED") }

func selectOwner(selection OwnerSelection, expected []ExpectedOwnerRecord) ([]ExpectedOwnerRecord, error) {
	if !domain.Identifier(selection.OwnerID, 160) || !domain.Identifier(selection.ProfileID, 160) || !domain.Identifier(selection.ComputerID, 160) || len(expected) < 1 || len(expected) > maxPreservedRecords {
		return nil, ownerRefusal()
	}
	closed := append([]ExpectedOwnerRecord(nil), expected...)
	for _, e := range closed {
		i := e.Binding.Identity
		key, err := recordKey(i)
		if err != nil || i.Scope != domain.ScopeOwnerSettings || i.OwnerID != selection.OwnerID || i.ProfileID != selection.ProfileID || i.ComputerID != selection.ComputerID || key != e.Key || !domain.SHA256(e.SHA256) {
			return nil, ownerRefusal()
		}
		if _, err := domain.NewPrepared(e.Binding); err != nil {
			return nil, ownerRefusal()
		}
	}
	sort.Slice(closed, func(i, j int) bool { return closed[i].Key < closed[j].Key })
	for n := 1; n < len(closed); n++ {
		if closed[n-1].Key == closed[n].Key {
			return nil, ownerRefusal()
		}
	}
	return closed, nil
}

func qualifyOwner(entries []settledBytes, expected []ExpectedOwnerRecord) ([]OwnerRetainedRecord, error) {
	if len(expected) < 1 || len(expected) > maxPreservedRecords || len(entries) != len(expected) {
		return nil, ownerRefusal()
	}
	entries = append([]settledBytes(nil), entries...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].key < entries[j].key })
	retained := make([]OwnerRetainedRecord, len(entries))
	for n, entry := range entries {
		e := expected[n]
		if e.Binding.Identity.Scope != domain.ScopeOwnerSettings || n > 0 && entries[n-1].key == entry.key {
			return nil, ownerRefusal()
		}
		// Explicitly map repository-owned DTOs to the private common qualifier.
		// Its original canonical decode, immutable binding/key and full-byte hash
		// checks admit an owner binding only through the schema2 owner codec.
		state, observed, err := qualifySettledRecord(entry, ExpectedSettledRecord{Key: e.Key, SHA256: e.SHA256, Binding: e.Binding})
		if err != nil || state.Phase() != domain.Completed || !completedSettledReceipt(state) {
			return nil, ownerRefusal()
		}
		retained[n] = OwnerRetainedRecord{Key: observed.Key, SHA256: observed.SHA256, Identity: observed.Identity}
	}
	return retained, nil
}

func observeOwnerCompleted(ctx context.Context, expected []ExpectedOwnerRecord, observation settledObservation, visit func(OwnerInspection) error) (*OwnerInspection, error) {
	if visit == nil {
		return nil, unavailable()
	}
	var result OwnerInspection
	var visitErr error
	err := observeSettledRecords(ctx, observation, func(entries []settledBytes) (err error) {
		result.Retained, err = qualifyOwner(entries, expected)
		return err
	}, func(meta SettledInspection) error {
		result.Root, result.MutationsDevice, result.MutationsInode = meta.Root, meta.MutationsDevice, meta.MutationsInode
		result.LockDevice, result.LockInode = meta.LockDevice, meta.LockInode
		copied := result
		copied.Retained = append([]OwnerRetainedRecord(nil), result.Retained...)
		// Capture the original error separately. The common lifecycle must still
		// run its full final recheck before we preserve that error unchanged.
		visitErr = visit(copied)
		return nil
	})
	if err != nil || ctx.Err() != nil {
		if err != nil {
			return nil, err
		}
		return nil, unavailable()
	}
	if visitErr != nil {
		return nil, visitErr
	}
	return &result, nil
}
