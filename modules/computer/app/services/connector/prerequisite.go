package connector

import (
	"context"

	journal "github.com/legrch/farol/modules/computer/domain/journal"
)

// StopPrerequisiteStore is the existing protected Computer access owner.
// It retains the original operation and every intent/ACK under one lifetime
// lock. This app service does not create another journal or Settings writer.
type StopPrerequisiteStore interface {
	BeginStop(context.Context, journal.StopRequest) (journal.StopEntry, bool, error)
	AdvanceStop(context.Context, string, journal.StopEntry) error
	ObserveOriginalStop(context.Context, string) (journal.StopEntry, error)
	ObserveStopLedger(context.Context) (journal.StopLedger, error)
	RefuseStopBeforeDispatch(context.Context, string) error
}

// StopNativeBoot is read by Go before any original Stop effect. Neither wire
// input nor renderer state supplies a boot UUID.
type StopNativeBoot interface {
	Current(context.Context) (string, error)
}

type StopConnectorBinding struct {
	BuildID, BackendGeneration, RuntimeID, ConnectorGeneration string
}

// StopConnectorEvidence is the current Go endpoint owner. It retains the
// original successful Close operation+digest independently of any TS result.
// These reads never dispatch or retry a connector operation.
type StopConnectorEvidence interface {
	CurrentStopBinding(context.Context) (StopConnectorBinding, error)
	VerifyOriginalClose(context.Context, string, string, string, string, string) error
}

type StopScope struct {
	ProfileID, OwnerID, ComputerID, BackendGeneration, HostLifetimeID string
}

type OriginalStopOwner struct {
	store     StopPrerequisiteStore
	boot      StopNativeBoot
	connector StopConnectorEvidence
	scope     StopScope
}

func NewOriginalStopOwner(store StopPrerequisiteStore, boot StopNativeBoot, connector StopConnectorEvidence, scope StopScope) *OriginalStopOwner {
	return &OriginalStopOwner{store: store, boot: boot, connector: connector, scope: scope}
}

// Begin produces the original durable stop_intent. Only first=true is a permit
// for the trusted native lifecycle owner to dispatch a SINGLE original Stop.
// If a reply is lost, the only subsequent operation is read-only observation.
func (o *OriginalStopOwner) Begin(ctx context.Context, proposed journal.StopRequest) (journal.StopEntry, bool, error) {
	if o == nil || o.store == nil || o.boot == nil || o.connector == nil ||
		ctx == nil || ctx.Err() != nil || o.scope.ProfileID == "" ||
		o.scope.OwnerID == "" || o.scope.ComputerID == "" ||
		o.scope.BackendGeneration == "" || o.scope.HostLifetimeID == "" {
		return journal.StopEntry{}, false, journal.ErrStopRefused
	}
	boot, err := o.boot.Current(ctx)
	if err != nil || ctx.Err() != nil {
		return journal.StopEntry{}, false, journal.ErrStopRefused
	}
	binding, err := o.connector.CurrentStopBinding(ctx)
	if err != nil || ctx.Err() != nil || binding.BackendGeneration != o.scope.BackendGeneration {
		return journal.StopEntry{}, false, journal.ErrStopRefused
	}
	// Host-owned current provenance is never accepted from a caller. Expected
	// Settings revisions/digests and policy remain frozen in the original
	// prepared command, with their separate sole-writer checks.
	proposed.ProfileID = o.scope.ProfileID
	proposed.OwnerID = o.scope.OwnerID
	proposed.ComputerID = o.scope.ComputerID
	proposed.BackendGeneration = o.scope.BackendGeneration
	proposed.HostLifetimeID = o.scope.HostLifetimeID
	proposed.BootUUID = boot
	proposed.RuntimeID = binding.RuntimeID
	proposed.ConnectorGeneration = binding.ConnectorGeneration
	proposed.BuildID = binding.BuildID
	if !journal.ValidStopRequest(proposed) {
		return journal.StopEntry{}, false, journal.ErrStopRefused
	}
	entry, first, err := o.store.BeginStop(ctx, proposed)
	if err != nil || !first {
		return entry, false, err
	}
	next := entry.Clone()
	next.Phase = journal.StopEffectIntent
	if err = o.store.AdvanceStop(ctx, proposed.OperationID, next); err != nil {
		return journal.StopEntry{}, false, err
	}
	if ctx.Err() != nil {
		return journal.StopEntry{}, false, journal.ErrStopUnknown
	}
	return next, true, nil
}

// Advance records exactly one next phase. Go independently validates the
// original Go connector Close ACK; TS lifecycle and Settings remain their own
// trusted effect owners. Neither equals-bytes nor a caller success boolean is
// an alternative proof of a lost original ACK.
func (o *OriginalStopOwner) Advance(
	ctx context.Context, parentID string, phase journal.StopPhase,
	closure *journal.StopClosure, plan *journal.StopSettingsPlan,
	settings *journal.StopSettingsReceipt, cleanup *journal.StopCleanupReceipt,
) (journal.StopEntry, error) {
	if o == nil || o.store == nil || ctx == nil || ctx.Err() != nil {
		return journal.StopEntry{}, journal.ErrStopRefused
	}
	entry, err := o.store.ObserveOriginalStop(ctx, parentID)
	if err != nil {
		return journal.StopEntry{}, err
	}
	next := entry.Clone()
	next.Phase = phase
	switch phase {
	case journal.StopAcknowledged:
		if closure == nil || plan != nil || settings != nil || cleanup != nil || o.connector == nil ||
			o.connector.VerifyOriginalClose(ctx, parentID, closure.ClosureOperationID,
				closure.ClosureDigest, closure.BackendGeneration, closure.RuntimeID) != nil {
			return journal.StopEntry{}, journal.ErrStopRefused
		}
		next.Closure = closure
	case journal.StoppedSettingsIntent:
		if plan == nil || closure != nil || settings != nil || cleanup != nil {
			return journal.StopEntry{}, journal.ErrStopRefused
		}
		next.SettingsIntent = plan
	case journal.StoppedSettingsAcknowledged:
		if settings == nil || closure != nil || plan != nil || cleanup != nil {
			return journal.StopEntry{}, journal.ErrStopRefused
		}
		next.SettingsAck = settings
	case journal.StopCleanupIntent:
		if closure != nil || plan != nil || settings != nil || cleanup != nil {
			return journal.StopEntry{}, journal.ErrStopRefused
		}
	case journal.StopComplete, journal.StopCleanupAcknowledged:
		// The desktop must produce a separate verified native directory
		// readback after cleanup. Independently recheck the original Go
		// connector closure, not a renderer boolean or a current idle status.
		if closure != nil || plan != nil || settings != nil ||
			entry.Closure == nil || o.connector == nil ||
			o.connector.VerifyOriginalClose(ctx, parentID,
				entry.Closure.ClosureOperationID, entry.Closure.ClosureDigest,
				entry.Closure.BackendGeneration, entry.Closure.RuntimeID) != nil {
			return journal.StopEntry{}, journal.ErrStopRefused
		}
		if phase == journal.StopCleanupAcknowledged {
			if cleanup == nil || cleanup.BackendGeneration != entry.Request.BackendGeneration ||
				cleanup.RuntimeID != entry.Request.RuntimeID {
				return journal.StopEntry{}, journal.ErrStopRefused
			}
			next.CleanupAck = cleanup
		} else if cleanup != nil || entry.CleanupAck == nil {
			return journal.StopEntry{}, journal.ErrStopRefused
		}
	default:
		return journal.StopEntry{}, journal.ErrStopRefused
	}
	if err = o.store.AdvanceStop(ctx, parentID, next); err != nil {
		return journal.StopEntry{}, err
	}
	return next, nil
}

func (o *OriginalStopOwner) RefuseBeforeStop(ctx context.Context, parentID string) error {
	if o == nil || o.store == nil || ctx == nil || ctx.Err() != nil {
		return journal.ErrStopRefused
	}
	return o.store.RefuseStopBeforeDispatch(ctx, parentID)
}

func (o *OriginalStopOwner) Status(ctx context.Context) (journal.StopLedger, error) {
	if o == nil || o.store == nil || ctx == nil || ctx.Err() != nil {
		return journal.StopLedger{}, journal.ErrStopRefused
	}
	return o.store.ObserveStopLedger(ctx)
}
