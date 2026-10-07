package handoff

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/chat/app/port"
)

// AcknowledgedLease retains an existing claim over exactly the canonical empty
// ORIGIN_CAPTURED -> HOST_ACKNOWLEDGED prefix. Its head, ACK digest and publication
// are persisted diagnostics only, never the original runtime acknowledgement,
// known child facts, origin proof, drain proof or completion/replay authority.
type AcknowledgedLease struct {
	mu                sync.Mutex
	head              *port.HandoffHead
	verify, close     func() error
	closed            bool
	failure, closeErr error
}

// AcquireAcknowledgedInspection opens and retains only existing read-only
// descriptors and the existing claim lock. It never creates, writes, syncs,
// poisons or repairs storage. The caller supplies the exact original binding and
// handoff ID; observation cannot recover either as runtime authority from bytes.
func AcquireAcknowledgedInspection(ctx context.Context, roots Roots, expected port.HandoffBinding, handoffID string) (*AcknowledgedLease, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, fail(Cancelled, false)
	}
	if !historyID(roots.ProfileID) || !historyID(expected.ProfileID) || !historyID(expected.BackendGeneration) || !historyID(expected.BuildID) || !historyID(expected.HostLifetimeID) || !historyID(expected.ChildLaunchID) || !historyID(handoffID) || expected.ProfileID != roots.ProfileID || expected.ParentRoot != roots.Parent.Identity || expected.ChatRoot != roots.Chat.Identity || expected.ParentRoot.Device == 0 || expected.ParentRoot.Inode == 0 || expected.ChatRoot.Device == 0 || expected.ChatRoot.Inode == 0 || expected.ParentRoot.Device != expected.ChatRoot.Device || expected.ParentRoot.OwnerUID != expected.ChatRoot.OwnerUID || expected.ParentRoot == expected.ChatRoot {
		return nil, fail(Invalid, false)
	}
	return acquireAcknowledgedInspection(ctx, roots, expected, handoffID)
}

func acknowledgedInspectionQualify(chain closedInspectionChain, expected port.HandoffBinding, handoffID string) error {
	head := chain.head
	if len(chain.stages) != 2 || chain.stages[0].Stage != port.HandoffCaptured || chain.stages[1].Stage != port.HandoffAcknowledged || head == nil || head.Record == nil || !head.EmptyRetirementChain {
		return fail(Refused, false)
	}
	r := head.Record
	if r.Stage != port.HandoffAcknowledged || r.Publication.Binding != expected || r.Publication.HandoffID != handoffID || r.ACK == nil || r.Terminal != nil || r.Consumption != nil {
		return fail(Refused, false)
	}
	return nil
}

// Observation returns an owned copy, or nil after failure or Close. Call Verify
// after using it: the snapshot remains provisional throughout the caller window.
func (l *AcknowledgedLease) Observation() *port.HandoffHead {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.failure != nil || l.verify == nil || l.close == nil {
		return nil
	}
	return copyClosedInspectionHead(l.head)
}

// Verify rechecks the entire chain, retained file identities/digests, roots and
// claim at their original canonical names. Failure is sticky for this lease.
func (l *AcknowledgedLease) Verify() error {
	if l == nil {
		return fail(Unavailable, false)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || l.verify == nil || l.close == nil {
		return fail(Unavailable, false)
	}
	if l.failure == nil {
		l.failure = l.verify()
	}
	return l.failure
}

// Close releases owned descriptors only, including after failed verification.
// It never discharges an UNKNOWN fence or returns completion authority.
func (l *AcknowledgedLease) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !l.closed {
		l.closed = true
		if l.close != nil {
			l.closeErr = l.close()
		}
	}
	return l.closeErr
}
