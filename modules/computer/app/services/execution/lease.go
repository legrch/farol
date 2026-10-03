package execution

import (
	"context"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Lease is the explicit operation-owned AccessRepository for existing app
// services. No global/ambient current execution exists. Use one lease for every
// admission and final disclosure phase of the same operation; never remint it.
type Lease struct {
	service *Service
	binding port.TaskBinding
	fixed   authority.ExecutionLease
}

var _ port.AccessRepository = (*Lease)(nil)

func (l *Lease) Deadline() time.Time                { return l.fixed.Deadline() }
func (l *Lease) Binding() port.TaskBinding          { return l.binding }
func (l *Lease) Participant() authority.Participant { return l.fixed.Participant() }
func (l *Lease) WithSnapshot(ctx context.Context, id string, inspect func(port.AccessSnapshot) error) error {
	if l == nil || l.service == nil || inspect == nil {
		return unavailable()
	}
	if id != l.binding.ParticipantID {
		return authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
	}
	return l.service.withCurrent(ctx, &l.binding, func(_ port.TaskBinding, snapshot port.AccessSnapshot) error {
		now := l.service.clock.Now()
		if err := l.fixed.Check(now); err != nil {
			return err
		}
		if now.After(snapshot.Approval.ExpiresAt) {
			return authority.Fail("AUTHORITY_EXPIRED", "computer-policy")
		}
		p, a := l.fixed.Participant(), snapshot.Approval.Clone()
		if err := cancelled(ctx); err != nil {
			return err
		}
		// Callback and response construction finish under both current owners.
		// Current expiry may shorten/refuse the lease, but cannot extend it.
		return inspect(port.AccessSnapshot{Participant: &p, Approval: &a})
	})
}
