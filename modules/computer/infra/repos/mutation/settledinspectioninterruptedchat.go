package mutation

import (
	"context"
	"sort"

	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

const interruptedChatSettledRecordCount = 5

// InterruptedChatSettledInspection observes only the independently selected
// interrupted Chat set. It conveys no execution or retirement authority.
// Retained is sorted by canonical key and copied by value to the visitor.
type InterruptedChatSettledInspection struct {
	Root                            Root
	MutationsDevice, MutationsInode uint64
	LockDevice, LockInode           uint64
	Retained                        [interruptedChatSettledRecordCount]SettledRetainedRecord
}

// InspectInterruptedChatSettled observes an existing CLOSED store containing
// exactly four canonical v3 connector workspace Completed receipts and one Failed
// native-workspace WORKSPACE_MUTATION_CONFLICT with no receipt. The trusted caller
// must independently select all five keys, complete-byte digests and full bindings,
// including the known preimage conflict; journal metadata cannot prove its origin
// or expand this set. Every other failure and uncertain state refuses.
//
// This shares InspectSettled's pins, existing exclusive nonblocking writer lock,
// canonical codec, exact namespace inventory, fresh rechecks and callback contract.
// It creates, replaces, syncs and deletes nothing. visit is required, synchronous,
// trusted observation code with the same cancellation and non-reentry limits as
// InspectSettled. The original exact-two Completed policy remains independent.
func InspectInterruptedChatSettled(ctx context.Context, root Root, selection SettledSelection, expected []ExpectedSettledRecord, visit func(InterruptedChatSettledInspection) error) (*InterruptedChatSettledInspection, error) {
	if ctx == nil || ctx.Err() != nil || !validRoot(root) || visit == nil {
		return nil, unavailable()
	}
	closed, err := selectInterruptedChatSettled(selection, expected)
	if err != nil {
		return nil, err
	}
	return inspectInterruptedChatSettledExisting(ctx, root, closed, visit)
}

func selectInterruptedChatSettled(selection SettledSelection, expected []ExpectedSettledRecord) ([interruptedChatSettledRecordCount]ExpectedSettledRecord, error) {
	var closed [interruptedChatSettledRecordCount]ExpectedSettledRecord
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
	sort.Slice(closed[:], func(i, j int) bool { return closed[i].Key < closed[j].Key })
	for n := 1; n < len(closed); n++ {
		if closed[n-1].Key == closed[n].Key {
			return closed, settledRefusal()
		}
	}
	return closed, nil
}

func qualifyInterruptedChatSettled(entries []settledBytes, expected [interruptedChatSettledRecordCount]ExpectedSettledRecord) ([interruptedChatSettledRecordCount]SettledRetainedRecord, error) {
	var retained [interruptedChatSettledRecordCount]SettledRetainedRecord
	if len(entries) != len(expected) {
		return retained, settledRefusal()
	}
	entries = append([]settledBytes(nil), entries...)
	sort.Slice(entries, func(i, j int) bool { return entries[i].key < entries[j].key })
	completed, conflicts := 0, 0
	for n, entry := range entries {
		state, observed, err := qualifySettledRecord(entry, expected[n])
		if err != nil {
			return retained, err
		}
		switch state.Phase() {
		case domain.Completed:
			if !completedSettledReceipt(state) {
				return retained, settledRefusal()
			}
			completed++
		case domain.Failed:
			f := state.Failure()
			if state.Receipt() != nil || f == nil || f.Code != "WORKSPACE_MUTATION_CONFLICT" || f.Source != "native-workspace" {
				return retained, settledRefusal()
			}
			conflicts++
		default:
			return retained, settledRefusal()
		}
		retained[n] = observed
	}
	if completed != 4 || conflicts != 1 {
		return retained, settledRefusal()
	}
	return retained, nil
}

func observeInterruptedChatSettled(ctx context.Context, expected [interruptedChatSettledRecordCount]ExpectedSettledRecord, observation settledObservation, visit func(InterruptedChatSettledInspection) error) (*InterruptedChatSettledInspection, error) {
	if visit == nil {
		return nil, unavailable()
	}
	var retained [interruptedChatSettledRecordCount]SettledRetainedRecord
	var result InterruptedChatSettledInspection
	err := observeSettledRecords(ctx, observation, func(entries []settledBytes) (err error) {
		retained, err = qualifyInterruptedChatSettled(entries, expected)
		return err
	}, func(meta SettledInspection) error {
		result = InterruptedChatSettledInspection{Root: meta.Root, MutationsDevice: meta.MutationsDevice, MutationsInode: meta.MutationsInode, LockDevice: meta.LockDevice, LockInode: meta.LockInode, Retained: retained}
		return visit(result)
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}
