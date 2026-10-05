package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/app/services/execution"
	workspacesvc "github.com/legrch/farol/modules/computer/app/services/workspace"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

func connectorVerificationState(ctx context.Context, slot *connectorSlot, lease *execution.Lease) (*wire.ComputerConnectorVerificationState, error) {
	proof, err := slot.owner.CurrentVerification(ctx)
	if err != nil {
		return nil, err
	}
	state := &wire.ComputerConnectorVerificationState{Binding: slot.opened.Endpoint.Binding}
	if proof != nil {
		call := sha256.Sum256([]byte(proof.CallID))
		receipt := &wire.ComputerConnectorVerificationReceipt{Binding: state.Binding, Execution: slot.opened.Execution,
			ChallengeSha256: hex.EncodeToString(proof.ChallengeDigest[:]), WorkspaceId: proof.WorkspaceID,
			CallIdSha256: hex.EncodeToString(call[:]), EntryCount: proof.EntryCount, Truncated: proof.Truncated}
		data, encodeErr := json.Marshal(receipt)
		if encodeErr != nil || wire.Validate("ComputerConnectorVerificationReceipt", data) != nil {
			return nil, computerUnavailable()
		}
		digest := sha256.Sum256(data)
		value := hex.EncodeToString(digest[:])
		state.Receipt, state.ReceiptSha256 = receipt, &value
	}
	// One operation lease encloses final disclosure after the owner observation.
	// Do not reenter the connector owner from this snapshot callback.
	if err = lease.WithSnapshot(ctx, slot.opened.Execution.ParticipantId, func(port.AccessSnapshot) error {
		data, e := json.Marshal(state)
		if e != nil || wire.Validate("ComputerConnectorVerificationState", data) != nil {
			return computerUnavailable()
		}
		return nil
	}); err != nil {
		return nil, err
	}
	return state, nil
}

func (s *computerConnector) verificationMethod(slot *connectorSlot) desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerConnectorVerify", request.Body) != nil {
			return invalidIngress()
		}
		var in wire.ComputerConnectorVerify
		if json.Unmarshal(request.Body, &in) != nil {
			return invalidIngress()
		}
		if err := s.enter(ctx); err != nil {
			return ingressOutcome(nil, err)
		}
		defer func() { <-s.effects }()
		if s.current != slot || slot.closing || slot.startupUncertain {
			return ingressOutcome(nil, computerUnavailable())
		}
		digest := sha256.Sum256([]byte(in.Challenge))
		if err := slot.owner.CheckVerificationChallenge(ctx, digest); err != nil {
			return ingressOutcome(nil, err)
		}
		previous, err := slot.owner.CurrentVerification(ctx)
		if err != nil {
			return ingressOutcome(nil, err)
		}
		if previous == nil {
			if err := slot.owner.BeginVerification(ctx, digest, in.WorkspaceId, in.CallId); err != nil {
				return ingressOutcome(nil, err)
			}
		}
		lease, err := slot.route.issuer.Admit(ctx, authority.List)
		if err != nil {
			return ingressOutcome(nil, err)
		}
		if previous != nil {
			if previous.WorkspaceID != in.WorkspaceId || previous.ChallengeDigest != digest {
				return ingressOutcome(nil, computerUnavailable())
			}
			state, err := connectorVerificationState(ctx, slot, lease)
			return ingressOutcome(state, err)
		}
		service, err := workspacesvc.NewForExecution(lease, slot.route.workspace, slot.route.clock)
		if err != nil {
			return ingressOutcome(nil, err)
		}
		e := slot.opened.Execution
		epoch, _ := strconv.ParseUint(e.TaskEpoch, 10, 64)
		generation, _ := strconv.ParseUint(e.Generation, 10, 64)
		input := workspacect.ListRequest{OwnerID: e.OwnerId, SessionID: e.SessionId, TaskID: e.TaskId, TaskEpoch: epoch,
			ParticipantID: e.ParticipantId, TurnID: e.TurnId, Generation: generation, CallID: in.CallId, WorkspaceID: in.WorkspaceId, RelativePath: "."}
		out, err := workspacect.New(service).List(ctx, input)
		if err != nil {
			return ingressOutcome(nil, err)
		}
		if out == nil || out.OwnerID != input.OwnerID || out.SessionID != input.SessionID || out.TaskID != input.TaskID || out.TaskEpoch != input.TaskEpoch ||
			out.ParticipantID != input.ParticipantID || out.TurnID != input.TurnID || out.Generation != input.Generation || out.CallID != input.CallID ||
			out.WorkspaceID != input.WorkspaceID || out.RelativePath != "." || len(out.Entries) > 500 {
			return ingressOutcome(nil, computerUnavailable())
		}
		observed := port.ConnectorVerification{Host: slot.guard.host, Binding: lease.Binding(), ChallengeDigest: digest,
			WorkspaceID: out.WorkspaceID, CallID: out.CallID, EntryCount: uint32(len(out.Entries)), Truncated: out.Truncated}
		if err = slot.owner.RecordVerification(ctx, digest, observed); err != nil {
			return ingressOutcome(nil, err)
		}
		state, err := connectorVerificationState(ctx, slot, lease)
		return ingressOutcome(state, err)
	}}
}

func (s *computerConnector) verificationObservationMethod() desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerConnectorVerificationQuery", request.Body) != nil {
			return invalidIngress()
		}
		var in wire.ComputerConnectorVerificationQuery
		if json.Unmarshal(request.Body, &in) != nil {
			return invalidIngress()
		}
		if err := s.enter(ctx); err != nil {
			return ingressOutcome(nil, err)
		}
		defer func() { <-s.effects }()
		slot := s.current
		if slot == nil || slot.closing || slot.startupUncertain || in.Binding != slot.opened.Endpoint.Binding {
			return ingressOutcome(nil, computerUnavailable())
		}
		lease, err := slot.route.issuer.Admit(ctx, authority.List)
		if err != nil {
			return ingressOutcome(nil, err)
		}
		state, err := connectorVerificationState(ctx, slot, lease)
		return ingressOutcome(state, err)
	}}
}
