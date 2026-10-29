package boot

import (
	"context"

	wire "github.com/legrch/farol/gen/desktop/v1"
	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// This is correlation for one successful Close in the existing backend owner,
// not a replacement operation journal. Only the inherited host can present it.
// Go cannot prove delivery of the Close reply or client-side UNKNOWN state;
// runtime/broker closure and client acknowledgement remain host admission gates.
type connectorRecoveryOrigin struct {
	binding      wire.ComputerConnectorBinding
	publication  wire.ComputerAuthorityPublication
	owner        string
	computer     string
	ledger       *SettingsMutationIngress
	consumed     bool
	ownerStopped bool
	retiredOwner *connectorsvc.Service
}

func (s *computerConnector) consumeRecovery(in wire.ComputerConnectorOpen) (*connectorRecoveryOrigin, error) {
	if in.RecoveryFrom == nil {
		return nil, nil
	}
	origin := s.closed
	if origin == nil || origin.consumed {
		return nil, computerUnavailable()
	}
	origin.consumed = true // A mismatch or policy refusal also consumes this origin.
	// ConnectorGeneration is the Settings configuration generation. Recovery
	// preserves that consent; RuntimeId distinguishes the replacement transport.
	if *in.RecoveryFrom != origin.binding || in.Publication != origin.publication ||
		origin.binding.ProfileId != s.root.peer.ProfileId || origin.binding.BackendGeneration != s.root.peer.BackendGeneration ||
		origin.binding.BuildId != BuildID || origin.owner != s.root.ownerID || origin.computer != s.root.computerID ||
		in.ConnectorGeneration != origin.binding.ConnectorGeneration || in.RuntimeId == origin.binding.RuntimeId {
		return nil, computerUnavailable()
	}
	return origin, nil
}

// Inspect current consent, never refresh it or freeze retirement. Normal Open's
// existing renewal/authority guards still own Settings revocation and publication.
func (s *computerConnector) recoveryAuthority(ctx context.Context, origin *connectorRecoveryOrigin) bool {
	if origin == nil || s.lifetime.Err() != nil || origin.owner != s.root.ownerID || origin.computer != s.root.computerID ||
		origin.binding.ProfileId != s.root.peer.ProfileId || origin.binding.BackendGeneration != s.root.peer.BackendGeneration || origin.binding.BuildId != BuildID {
		return false
	}
	current, err := s.root.settingsAuthority(ctx, origin.publication)
	if err != nil {
		return false
	}
	return current.WithCurrent(ctx, func(approval *authority.Approval) error {
		if approval == nil || decimal(approval.Generation) != origin.publication.Generation || !s.clock.Now().Before(approval.ExpiresAt) {
			return computerUnavailable()
		}
		return nil
	}) == nil
}

// Caller holds ledger.mu. Settlement is qualified retained state, never a lack
// of telemetry. Inspect every original record, including Settings operations.
func (s *SettingsMutationIngress) recoveryDispositionLocked(reserved bool) string {
	if s.operations == nil || s.dependencies.repository == nil || s.dependencies.native == nil || s.dependencies.digester == nil ||
		s.frozen || s.processDraining || s.retirementErr != nil || s.recoveryReserved != reserved {
		return "unavailable"
	}
	pending := s.stagePending
	for _, record := range s.operations {
		if record == nil {
			return "operation_unknown"
		}
		if p := record.process; p != nil {
			if p.cancelUnknown || p.collectionErr != nil || p.publishAttempted && p.publication == "" || p.collectionDone == nil {
				return "operation_unknown"
			}
			collecting := false
			select {
			case <-p.collectionDone:
			default:
				collecting = true
			}
			if p.cancelling || p.capturing || collecting || record.pending {
				pending = true
				continue
			}
		}
		if record.pending {
			pending = true
		} else if !record.settled {
			return "operation_unknown"
		}
	}
	if pending {
		return "pending_operation"
	}
	return "settled"
}

func (s *computerConnector) recoveryDisposition(ctx context.Context, origin *connectorRecoveryOrigin, reserved bool) string {
	if !s.recoveryAuthority(ctx, origin) {
		return "authority_unknown"
	}
	ledger := s.mutations
	if ledger == nil || origin.ledger != ledger || ledger.computer != s.root {
		return "unavailable"
	}
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	return ledger.recoveryDispositionLocked(reserved)
}

func (s *computerConnector) reserveRecovery(ctx context.Context, origin *connectorRecoveryOrigin) error {
	if !s.recoveryAuthority(ctx, origin) {
		return computerUnavailable()
	}
	ledger := s.mutations
	if ledger == nil || origin.ledger != ledger || ledger.computer != s.root {
		return computerUnavailable()
	}
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if ledger.recoveryDispositionLocked(false) != "settled" {
		return computerUnavailable()
	}
	ledger.recoveryReserved = true
	return nil
}

func (s *computerConnector) checkRecovery(ctx context.Context, origin *connectorRecoveryOrigin) error {
	if s.recoveryDisposition(ctx, origin, true) != "settled" {
		return computerUnavailable()
	}
	return nil
}

func (s *computerConnector) releaseRecovery(origin *connectorRecoveryOrigin) {
	// The exact existing ledger remains the owner even if composition changes.
	origin.ledger.mu.Lock()
	origin.ledger.recoveryReserved = false
	origin.ledger.mu.Unlock()
}
