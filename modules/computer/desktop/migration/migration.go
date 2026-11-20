package migration

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/services/migration"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/modules/computer/domain/observation"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

const settingsSchema = "farol.workspace-continuity/1"

type owner interface {
	Begin(context.Context, migration.Selection) (migration.BeginResult, error)
	Confirm(context.Context, string, string, bool) (migration.ConfirmResult, error)
	Plan(context.Context, string, journal.Phase) (journal.Receipt, error)
	Record(context.Context, string, journal.Phase, journal.Receipt) error
	WithdrawOnce(context.Context, string, migration.WithdrawEffect) (journal.Receipt, error)
	StageOnce(context.Context, string, migration.StageEffect) (journal.Receipt, error)
	Finish(context.Context, string, journal.Phase, journal.Receipt) error
}

type parent interface {
	Select(context.Context, string, migration.Mode, observation.Saved) (migration.Selection, error)
}

type adapter struct {
	owner    owner
	parent   parent
	withdraw migration.WithdrawEffect
	stage    migration.StageEffect
	qualify  func(context.Context, string) (bool, error)
}

// Methods belongs to the trusted desktop pipe. The connector and renderer do
// not receive these methods, original native receipts, or picker attestation.
func Methods(o owner, p parent, withdraw migration.WithdrawEffect, stage migration.StageEffect, qualify func(context.Context, string) (bool, error)) map[string]desktop.Method {
	a := adapter{owner: o, parent: p, withdraw: withdraw, stage: stage, qualify: qualify}
	return map[string]desktop.Method{
		"computer.continuity.begin":    method("ComputerContinuityBeginRequest", beginEffect, a.begin),
		"computer.continuity.confirm":  method("ComputerContinuityConfirmRequest", followupEffect, a.confirm),
		"computer.continuity.plan":     method("ComputerContinuityPlanRequest", readOnly, a.plan),
		"computer.continuity.record":   method("ComputerContinuityRecordRequest", followupEffect, a.record),
		"computer.continuity.withdraw": method("ComputerContinuityOperationRequest", followupEffect, a.withdrawOnce),
		"computer.continuity.stage":    method("ComputerContinuityOperationRequest", followupEffect, a.stageOnce),
		"computer.continuity.finish":   method("ComputerContinuityFinishRequest", followupEffect, a.finish),
		"computer.continuity.qualify":  method("ComputerContinuityOperationRequest", followupEffect, a.qualifyCurrent),
	}
}

type dispatchKind uint8

const (
	beginEffect dispatchKind = iota
	followupEffect
	readOnly
)

func method[T any](shape string, kind dispatchKind, handle func(context.Context, T) (any, error)) desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, req desktop.Request) (*desktop.Outcome, error) {
		if ipc.ValidateJSON(req.Body) != nil || wire.Validate(shape, req.Body) != nil {
			return invalid()
		}
		var scope wire.ComputerContinuityOperationRequest
		if json.Unmarshal(req.Body, &scope) != nil {
			return invalid()
		}
		switch kind {
		case readOnly:
			if req.OperationID != "" {
				return invalid()
			}
		case beginEffect:
			if req.OperationID != scope.OperationId {
				return invalid()
			}
		case followupEffect:
			if req.OperationID == "" || req.OperationID == scope.OperationId {
				return invalid()
			}
		}
		var body T
		if json.Unmarshal(req.Body, &body) != nil {
			return invalid()
		}
		value, err := handle(ctx, body)
		return outcome(value, err)
	}}
}

func invalid() (*desktop.Outcome, error) {
	return &desktop.Outcome{Status: "refused", Code: "invalid_ingress_request"}, nil
}

var errQualificationUnavailable = errors.New("computer_continuity_current_unavailable")

func outcome(value any, err error) (*desktop.Outcome, error) {
	if err != nil {
		switch {
		case errors.Is(err, journal.ErrUnknown), errors.Is(err, journal.ErrStopUnknown):
			return nil, err // shared transport reports owner_outcome_unknown
		case errors.Is(err, errQualificationUnavailable):
			return &desktop.Outcome{Status: "unavailable", Code: "computer_continuity_current_unavailable"}, nil
		case errors.Is(err, journal.ErrRefused), errors.Is(err, journal.ErrPending):
			return &desktop.Outcome{Status: "refused", Code: "computer_continuity_refused"}, nil
		}
		// An exact known pre-effect refusal may be reported. Wrappers can also
		// carry uncertain I/O and must never be unwrapped into a clean refusal.
		if refusal, ok := err.(*authority.Failure); ok {
			return &desktop.Outcome{Status: "refused", Code: refusal.Code}, nil
		}
		return nil, err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &desktop.Outcome{Status: "ok", Data: data}, nil
}

func (a adapter) begin(ctx context.Context, body wire.ComputerContinuityBeginRequest) (any, error) {
	saved := observation.Saved{Binding: observation.Binding{Device: body.SavedBinding.Device, Inode: body.SavedBinding.Inode}}
	if e := body.SavedEvidence; e != nil {
		saved.Evidence = &observation.Evidence{
			Schema: observation.EvidenceSchema, Filesystem: "apfs",
			VolumeUUID: e.VolumeUuid, FileID: e.FileId,
			BirthSeconds: e.BirthSeconds, BirthNanoseconds: e.BirthNanoseconds,
		}
	}
	selection, err := a.parent.Select(ctx, body.OperationId, migration.Mode(body.Mode), saved)
	if err != nil {
		return nil, err
	}
	result, err := a.owner.Begin(ctx, selection)
	if err != nil {
		return nil, err
	}
	if !result.Admitted {
		return nil, journal.ErrRefused
	}
	return wire.ComputerContinuityBeginResponse{
		OperationId: result.OperationID, Admitted: result.Admitted, PriorPhase: string(result.PriorPhase),
	}, nil
}

func (a adapter) confirm(ctx context.Context, body wire.ComputerContinuityConfirmRequest) (any, error) {
	if (body.OwnerPicked && !observation.CanonicalPath(body.SelectedRoot)) || (!body.OwnerPicked && body.SelectedRoot != "") {
		return nil, journal.ErrRefused
	}
	result, err := a.owner.Confirm(ctx, body.OperationId, body.SelectedRoot, body.OwnerPicked)
	if err != nil {
		return nil, err
	}
	req, e := result.Request, result.Evidence
	// The Settings writer retains existing enrollment provenance on rebind.
	// A legacy enrollment's timestamp comes from the trusted host writer.
	return wire.ComputerContinuityConfirmResponse{
		OperationId: req.OperationID, ComputerId: req.ComputerID, WorkspaceId: req.WorkspaceID, Root: result.Binding.Path,
		RootIdentity:     wire.ComputerContinuityRootIdentity{Device: result.Binding.Device, Inode: result.Binding.Inode},
		ExpectedRevision: req.ExpectedRevision, ExpectedGeneration: req.ExpectedGeneration, ExpectedConsentSha256: req.ConsentDigest,
		Continuity: wire.ComputerContinuitySavedEvidence{
			Schema: settingsSchema, VolumeUuid: e.VolumeUUID, FileId: e.FileID,
			BirthSeconds: e.BirthSeconds, BirthNanoseconds: e.BirthNanoseconds,
		},
	}, nil
}

func effectReceipt(r journal.Receipt, err error) (any, error) {
	return wire.ComputerContinuityReceipt{EffectId: r.EffectID, Digest: r.Digest}, err
}

func (a adapter) plan(ctx context.Context, body wire.ComputerContinuityPlanRequest) (any, error) {
	return effectReceipt(a.owner.Plan(ctx, body.OperationId, journal.Phase(body.Phase)))
}

func (a adapter) record(ctx context.Context, body wire.ComputerContinuityRecordRequest) (any, error) {
	err := a.owner.Record(ctx, body.OperationId, journal.Phase(body.Phase), journal.Receipt{EffectID: body.Receipt.EffectId, Digest: body.Receipt.Digest})
	return wire.ComputerContinuityPhaseResponse{OperationId: body.OperationId, Phase: body.Phase}, err
}

func (a adapter) withdrawOnce(ctx context.Context, body wire.ComputerContinuityOperationRequest) (any, error) {
	return effectReceipt(a.owner.WithdrawOnce(ctx, body.OperationId, a.withdraw))
}

func (a adapter) stageOnce(ctx context.Context, body wire.ComputerContinuityOperationRequest) (any, error) {
	return effectReceipt(a.owner.StageOnce(ctx, body.OperationId, a.stage))
}

func (a adapter) finish(ctx context.Context, body wire.ComputerContinuityFinishRequest) (any, error) {
	cleanup, err := a.owner.Plan(ctx, body.OperationId, journal.CloseIntent)
	if err != nil {
		return nil, err
	}
	err = a.owner.Finish(ctx, body.OperationId, journal.Phase(body.Kind), cleanup)
	return wire.ComputerContinuityPhaseResponse{OperationId: body.OperationId, Phase: body.Kind}, err
}

func (a adapter) qualifyCurrent(ctx context.Context, body wire.ComputerContinuityOperationRequest) (any, error) {
	qualified, err := a.qualify(ctx, body.OperationId)
	if err != nil {
		return nil, err
	}
	if !qualified {
		return nil, errQualificationUnavailable
	}
	return wire.ComputerContinuityQualifyResponse{OperationId: body.OperationId, Qualified: true}, nil
}
