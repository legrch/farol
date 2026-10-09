package boot

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// This is a join of the existing live host, owner publication and sole Store.
// No request body can select it or supply renewable/current proof. The original
// Settings receipt and connector participant/launch remain immutable.
type connectorRenewalScope struct {
	guard *connectorHostGuard
	owner *connectorsvc.Service
	seal  port.ConnectorExecutionCeiling
}

type renewalApprovalStore interface {
	UpdateApprovalWithPublication(context.Context, uint64, authority.Approval, func(func() error) error) error
}

func (p *knownComputerPublication) current() authority.Approval {
	if p.currentApproval != nil {
		return p.currentApproval.Clone()
	}
	return p.approval.Clone()
}

func (s *ComputerIngress) refreshCurrentApproval(ctx context.Context) error {
	s.mu.Lock()
	scope := s.renewal
	s.mu.Unlock()
	return s.refreshApproval(ctx, scope)
}

// Renewal occurs ONLY before admission of a new operation, or in the bounded
// proactive poll. It never touches an issued lease, old intent or mutation.
func (s *ComputerIngress) refreshApproval(ctx context.Context, scope *connectorRenewalScope) error {
	if ctx == nil || ctx.Err() != nil {
		return computerUnavailable()
	}
	s.effects.Lock()
	defer s.effects.Unlock()
	if s.retiring || ctx.Err() != nil {
		return computerUnavailable()
	}
	s.approvalProjection.Lock()
	defer s.approvalProjection.Unlock()
	store, ok := s.store.(ownerApprovalStore)
	if !ok {
		return computerUnavailable()
	}
	clock := s.clock
	if clock == nil {
		clock = accessrepo.Clock{}
	}
	var observedAt time.Time
	var plan *authority.ApprovalRefreshPlan
	var publication *knownComputerPublication
	var revision uint64
	// Access -> connector owner -> host/activation -> root. The independent
	// standing-consent owner is this original acknowledged Settings publication,
	// explicitly selected by its private producer until withdrawal. A fresh
	// guarded read, not an expired Store snapshot, establishes its currentness.
	err := store.WithOwnerApproval(ctx, func(status accessrepo.Status, stored *authority.Approval) error {
		return s.withRenewalCurrent(ctx, scope, func() error {
			p := s.publication
			// Known Store observation and current owner precede any claim/write.
			// Absence here is a refusal, unlike missing post-commit readback below.
			if stored == nil || !status.ApprovalPresent {
				return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
			}
			if status.Generation != p.approval.Generation ||
				!authority.SameApprovalPolicy(*stored, p.approval) || !stored.ExpiresAt.Equal(p.current().ExpiresAt) {
				return computerUnavailable()
			}
			if !p.renewable {
				return nil
			}
			now := clock.Now().Truncate(time.Millisecond)
			observedAt = now
			fence, err := strconv.ParseUint(p.receipt.Fence, 10, 64)
			if err != nil {
				return computerUnavailable()
			}
			b := authority.ApprovalRefreshBinding{ProfileID: s.peer.ProfileId, BackendGeneration: s.peer.BackendGeneration,
				PublicationOperationID: p.receipt.PublishOperationId, Fence: fence, StoreRevision: status.Revision,
				ComputerGeneration: p.approval.Generation}
			planner := authority.PlanOwnerApprovalRefresh
			if scope != nil {
				b.ConnectorGeneration = scope.guard.host.ConnectorGeneration
				planner = authority.PlanApprovalRefresh
			}
			consent := p.approval.Clone()
			consent.ExpiresAt = now.Add(authority.TaskGrantLifetime)
			w := authority.ApprovalRefreshWitness{Binding: b, Approval: consent, ObservedAt: now, Current: true, Renewable: true}
			plan, err = planner(p.approval, *stored, b, w, now)
			publication, revision = p, status.Revision
			return err
		})
	})
	if err != nil || plan == nil || !plan.Publish {
		return err
	}
	publicationStore, ok := s.store.(renewalApprovalStore)
	if !ok {
		return computerUnavailable()
	}
	// Qualify the original live participant independently. Store CAS protects
	// policy revocation; the final publication gate below also protects live
	// withdrawal, which does not itself change the Store revision.
	if scope != nil {
		err = s.store.WithSnapshot(ctx, scope.seal.Participant.ParticipantID, func(snapshot port.AccessSnapshot) error {
			if snapshot.Participant == nil || snapshot.Approval == nil ||
				!authority.SameParticipantCeiling(*snapshot.Participant, scope.seal.Participant) ||
				!authority.SameApprovalPolicy(*snapshot.Approval, scope.seal.Approval) {
				return computerUnavailable()
			}
			return s.withRenewalCurrent(ctx, scope, func() error { return nil })
		})
		if err != nil {
			return err
		}
	}
	if now := clock.Now(); now.Before(observedAt) || now.Sub(observedAt) > authority.ApprovalRefreshObservationAge {
		return computerUnavailable()
	}
	operation, err := randomIngressID()
	if err != nil {
		return err
	}
	if err = s.claim(operation); err != nil {
		return err
	}
	if err = publicationStore.UpdateApprovalWithPublication(ctx, revision, plan.Approval, func(publish func() error) error {
		return s.withRenewalCurrent(ctx, scope, func() error {
			if s.publication != publication || !publication.renewable {
				return computerUnavailable()
			}
			if now := clock.Now(); now.Before(observedAt) || now.Sub(observedAt) > authority.ApprovalRefreshObservationAge {
				return computerUnavailable()
			}
			return publish()
		})
	}); err != nil {
		// Store's classified pre-write/CAS refusal is known. Disk uncertainty or
		// an unclassified result permanently fences the root, without retry.
		var known *authority.Failure
		if accessrepo.OutcomeUnknown(err) || !errors.As(err, &known) {
			s.poison()
		}
		return err
	}
	// The Store acknowledged this one effect. Read it back independently of
	// caller/connector cancellation; withdrawal still denies all new work.
	readback, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	err = store.WithOwnerApproval(readback, func(status accessrepo.Status, current *authority.Approval) error {
		s.guard.mu.Lock()
		defer s.guard.mu.Unlock()
		s.mu.Lock()
		defer s.mu.Unlock()
		if readback.Err() != nil || s.publication != publication || current == nil || !status.ApprovalPresent || status.Revision != revision+1 ||
			status.Generation != publication.approval.Generation || publication.refreshCount == ^uint64(0) ||
			!authority.SameApprovalPolicy(*current, plan.Approval) || !current.ExpiresAt.Equal(plan.Approval.ExpiresAt) {
			return computerUnavailable()
		}
		copy := current.Clone()
		publication.currentApproval = &copy
		publication.refreshCount++
		return nil
	})
	if err != nil {
		s.poison()
		return err
	}
	// A known commit is not a positive activation receipt. Recheck currentness
	// separately, refusing a closed host without corrupting clean retirement.
	return s.withRenewalCurrent(ctx, scope, func() error { return nil })
}

// Call under the Store gate for planning/participant qualification. The final
// post-commit liveness check needs no Store access and uses the same lock order.
func (s *ComputerIngress) withRenewalCurrent(ctx context.Context, scope *connectorRenewalScope, inspect func() error) error {
	if scope != nil {
		return scope.owner.WithCurrent(ctx, func(binding *port.TaskBinding) error {
			// Concrete host guard holds activation/root here; never nest them.
			if binding == nil || s.unknown || s.renewal != scope || s.publication == nil ||
				s.publication.receipt != scope.guard.publication || scope.guard.host.ProfileID != s.peer.ProfileId ||
				scope.guard.host.BackendGeneration != s.peer.BackendGeneration {
				return computerUnavailable()
			}
			return inspect()
		})
	}
	s.guard.mu.Lock()
	defer s.guard.mu.Unlock()
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.publication
	if ctx.Err() != nil || s.unknown || s.guard.exhausted || p == nil ||
		strconv.FormatUint(s.guard.revision, 10) != p.receipt.Fence ||
		p.approval.OwnerID != s.ownerID || p.approval.ComputerID != s.computerID {
		return computerUnavailable()
	}
	return inspect()
}

// Wall-clock expiry is rechecked on every new request after wake; this poll is
// only proactive coverage. A failed attempt ends polling, never retries an effect.
func (s *computerConnector) startRenewal(slot *connectorSlot, scope *connectorRenewalScope) {
	ctx, cancel := context.WithCancel(s.lifetime)
	slot.renewalCancel, slot.renewalDone = cancel, make(chan struct{})
	go func() {
		defer close(slot.renewalDone)
		timer := time.NewTicker(time.Minute)
		defer timer.Stop()
		s.pollRenewal(ctx, scope, timer.C)
	}()
}

func (s *computerConnector) pollRenewal(ctx context.Context, scope *connectorRenewalScope, ticks <-chan time.Time) {
	for {
		select {
		case <-ctx.Done():
			return
		case _, open := <-ticks:
			if !open {
				return
			}
			bounded, stop := context.WithTimeout(ctx, 5*time.Second)
			err := s.root.refreshApproval(bounded, scope)
			stop()
			if err != nil {
				return
			}
		}
	}
}
