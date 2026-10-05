package lifecycle

import (
	"context"
	"crypto/sha256"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Inspection describes only an existing canonical snapshot observed under the
// claim lock. It contains no prompts, result bodies, handles or origin proof.
// It is diagnostic data, never recovery, admission, successor or replay authority.
// Boot/Lead still owns whole-profile inventories and all owner decisions.
type Inspection struct {
	Scope          port.JournalScope
	Root           port.JournalRoot
	SnapshotDigest [32]byte
	Version        int
	// Counts cover the current snapshot scope only. WriteCount excludes the
	// separate retirement record; TurnCount counts unique recorded admissions.
	WriteCount int
	TurnCount  int
	// Incarnations preserves the exact recorded generation history, ending in
	// Scope.BackendGeneration. It inventories no other profile resources.
	Incarnations []string
	Retirement   *InspectionRetirement
	// EmptyFirstIncarnation means exactly one recorded incarnation, no writes
	// and no retirement in this snapshot. It does NOT mean an unused profile:
	// original unknown Start, hidden staging and external effects remain unknown.
	EmptyFirstIncarnation bool
}

// InspectionRetirement reports recorded metadata only. Even canonical retirement
// bytes cannot prove known publication, a received ACK, descriptor closure or
// backend-child exit. This type deliberately supplies no CleanRetirement method
// and no RetirementReceipt or cleanup witnesses.
type InspectionRetirement struct {
	PreviousRevision, Revision uint64
	TurnCount                  int
}

// Inspect reads an EXISTING snapshot after nonblocking exclusive qualification of
// its EXISTING claim. It creates no writer, mutates/syncs no file and removes no
// fence. Lock availability proves only serialization during this read, not clean
// retirement. Neither success nor failure discharges any preexisting unknown.
func Inspect(ctx context.Context, root Root, limits Limits) (*Inspection, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, failure(Cancelled, false)
	}
	if !validID(root.ProfileID) || !validLimits(limits) {
		return nil, failure(Invalid, false)
	}
	return inspectClosedSnapshot(ctx, root, limits)
}

// Pure canonical classification; native inspection retains the claim lock while
// calling this helper and rechecks the exact bytes before releasing descriptors.
func inspectRecord(raw []byte, root Root, limits Limits) (*Inspection, error) {
	value, err := decode(raw, limits)
	if err != nil {
		return nil, failure(Invalid, false)
	}
	if value.Root != root.identity() || value.Scope.ProfileID != root.ProfileID {
		return nil, failure(Refused, false)
	}
	turns := 0
	for _, w := range value.Writes {
		// The canonical decoder already checks unique admissions and all exact
		// queue transitions. Counting admissions needs no new replay/registry.
		if w.Entry.Kind == "admit" {
			turns++
		}
	}
	inspection := &Inspection{
		Scope: value.Scope, Root: value.Root, SnapshotDigest: sha256.Sum256(raw),
		Version: value.Version, WriteCount: len(value.Writes), TurnCount: turns,
		Incarnations:          append([]string(nil), value.Incarnations...),
		EmptyFirstIncarnation: len(value.Incarnations) == 1 && len(value.Writes) == 0 && value.Retirement == nil,
	}
	if w := value.Retirement; w != nil {
		inspection.Retirement = &InspectionRetirement{
			PreviousRevision: w.PreviousRevision, Revision: w.Revision, TurnCount: len(w.Turns),
		}
	}
	return inspection, nil
}
