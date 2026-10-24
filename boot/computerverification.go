package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
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

// Verification consumes the workspace's published contract. Preserve its
// classified read refusal instead of turning that independent DTO into a lost
// owner result. An incomplete one-shot proof stays unknown and cannot replay.
func connectorVerificationOutcome(value any, err error) (*desktop.Outcome, error) {
	var workspace *workspacect.Failure
	if errors.As(err, &workspace) {
		return &desktop.Outcome{Status: "refused", Code: workspace.Code}, nil
	}
	var policy *authority.Failure
	if errors.As(err, &policy) && policy.Code == "COMPUTER_CONNECTOR_VERIFICATION_UNCONFIRMED" {
		return &desktop.Outcome{Status: "unknown", Code: policy.Code}, nil
	}
	return ingressOutcome(value, err)
}

func connectorVerificationState(ctx context.Context, slot *connectorSlot, lease *execution.Lease) (*wire.ComputerConnectorVerificationState, error) {
	proof, err := slot.owner.CurrentVerification(ctx)
	if err != nil {
		return nil, err
	}
	state := &wire.ComputerConnectorVerificationState{Binding: slot.opened.Endpoint.Binding}
	if proof != nil {
		call := sha256.Sum256([]byte(proof.CallID))
		var receiptValue any
		receipt := &wire.ComputerConnectorVerificationReceipt{Binding: state.Binding, Execution: slot.opened.Execution,
			ChallengeSha256: hex.EncodeToString(proof.ChallengeDigest[:]), WorkspaceId: proof.WorkspaceID,
			CallIdSha256: hex.EncodeToString(call[:]), EntryCount: proof.EntryCount, Truncated: proof.Truncated}
		state.Receipt, receiptValue = receipt, receipt
		receiptType := "ComputerConnectorVerificationReceipt"
		if proof.Catalogue {
			if proof.WorkspaceID != "" || proof.EntryCount != 0 || proof.Truncated {
				return nil, computerUnavailable()
			}
			state.Receipt = nil
			state.CatalogueReceipt = &wire.ComputerConnectorCatalogueVerificationReceipt{Binding: state.Binding, Execution: slot.opened.Execution,
				ChallengeSha256: hex.EncodeToString(proof.ChallengeDigest[:]), CallIdSha256: hex.EncodeToString(call[:]), WorkspaceCount: 0}
			receiptValue, receiptType = state.CatalogueReceipt, "ComputerConnectorCatalogueVerificationReceipt"
		}
		data, encodeErr := json.Marshal(receiptValue)
		if encodeErr != nil || wire.Validate(receiptType, data) != nil {
			return nil, computerUnavailable()
		}
		digest := sha256.Sum256(data)
		value := hex.EncodeToString(digest[:])
		state.ReceiptSha256 = &value
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
	return s.verificationMethodFor(slot, false)
}

func (s *computerConnector) catalogueVerificationMethod(slot *connectorSlot) desktop.Method {
	return s.verificationMethodFor(slot, true)
}

func (s *computerConnector) verificationMethodFor(slot *connectorSlot, catalogue bool) desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		inputType := "ComputerConnectorVerify"
		if catalogue {
			inputType = "ComputerConnectorCatalogueVerify"
		}
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate(inputType, request.Body) != nil {
			return invalidIngress()
		}
		var in wire.ComputerConnectorVerify
		if json.Unmarshal(request.Body, &in) != nil {
			return invalidIngress()
		}
		if err := s.enter(ctx); err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		defer func() { <-s.effects }()
		if s.current != slot || slot.closing || slot.startupUncertain {
			return connectorVerificationOutcome(nil, computerUnavailable())
		}
		digest := sha256.Sum256([]byte(in.Challenge))
		if err := s.root.refreshApproval(ctx, slot.renewalScope); err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		if err := slot.owner.CheckVerificationChallenge(ctx, digest); err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		previous, err := slot.owner.CurrentVerification(ctx)
		if err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		if previous == nil {
			var err error
			if catalogue {
				err = slot.owner.BeginCatalogueVerification(ctx, digest, in.CallId)
			} else {
				err = slot.owner.BeginVerification(ctx, digest, in.WorkspaceId, in.CallId)
			}
			if err != nil {
				return connectorVerificationOutcome(nil, err)
			}
		}
		var lease *execution.Lease
		if catalogue {
			lease, err = slot.route.admitCatalogue(ctx)
		} else {
			lease, err = slot.route.admit(ctx, authority.List)
		}
		if err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		if previous != nil {
			if previous.Catalogue != catalogue || previous.WorkspaceID != in.WorkspaceId || previous.ChallengeDigest != digest {
				return connectorVerificationOutcome(nil, computerUnavailable())
			}
			state, err := connectorVerificationState(ctx, slot, lease)
			return connectorVerificationOutcome(state, err)
		}
		service, err := workspacesvc.NewForExecution(lease, slot.route.workspace, slot.route.clock)
		if err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		e := slot.opened.Execution
		epoch, _ := strconv.ParseUint(e.TaskEpoch, 10, 64)
		generation, _ := strconv.ParseUint(e.Generation, 10, 64)
		if catalogue {
			input := workspacect.CatalogueRequest{OwnerID: e.OwnerId, SessionID: e.SessionId, TaskID: e.TaskId, TaskEpoch: epoch,
				ParticipantID: e.ParticipantId, TurnID: e.TurnId, Generation: generation, CallID: in.CallId}
			out, err := workspacect.New(service).Catalogue(ctx, input)
			if err != nil {
				return connectorVerificationOutcome(nil, err)
			}
			if out == nil || out.OwnerID != input.OwnerID || out.SessionID != input.SessionID || out.TaskID != input.TaskID || out.TaskEpoch != input.TaskEpoch ||
				out.ParticipantID != input.ParticipantID || out.TurnID != input.TurnID || out.Generation != input.Generation || out.CallID != input.CallID || out.Workspaces == nil || len(out.Workspaces) != 0 {
				return connectorVerificationOutcome(nil, computerUnavailable())
			}
			observed := port.ConnectorVerification{Host: slot.guard.host, Binding: lease.Binding(), ChallengeDigest: digest, CallID: out.CallID, Catalogue: true}
			if err := slot.owner.RecordVerification(ctx, digest, observed); err != nil {
				return connectorVerificationOutcome(nil, err)
			}
			state, err := connectorVerificationState(ctx, slot, lease)
			return connectorVerificationOutcome(state, err)
		}
		input := workspacect.ListRequest{OwnerID: e.OwnerId, SessionID: e.SessionId, TaskID: e.TaskId, TaskEpoch: epoch,
			ParticipantID: e.ParticipantId, TurnID: e.TurnId, Generation: generation, CallID: in.CallId, WorkspaceID: in.WorkspaceId, RelativePath: "."}
		out, err := workspacect.New(service).List(ctx, input)
		if err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		if out == nil || out.OwnerID != input.OwnerID || out.SessionID != input.SessionID || out.TaskID != input.TaskID || out.TaskEpoch != input.TaskEpoch ||
			out.ParticipantID != input.ParticipantID || out.TurnID != input.TurnID || out.Generation != input.Generation || out.CallID != input.CallID ||
			out.WorkspaceID != input.WorkspaceID || out.RelativePath != "." || len(out.Entries) > 500 {
			return connectorVerificationOutcome(nil, computerUnavailable())
		}
		observed := port.ConnectorVerification{Host: slot.guard.host, Binding: lease.Binding(), ChallengeDigest: digest,
			WorkspaceID: out.WorkspaceID, CallID: out.CallID, EntryCount: uint32(len(out.Entries)), Truncated: out.Truncated}
		if err = slot.owner.RecordVerification(ctx, digest, observed); err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		state, err := connectorVerificationState(ctx, slot, lease)
		return connectorVerificationOutcome(state, err)
	}}
}

func (s *computerConnector) verificationObservationMethod() desktop.Method {
	return s.verificationObservationMethodFor(nil)
}

// The trusted desktop host observes its current slot. A connector socket must
// remain bound to the exact retained slot that originally published that socket.
func (s *computerConnector) verificationObservationMethodFor(expected *connectorSlot) desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerConnectorVerificationQuery", request.Body) != nil {
			return invalidIngress()
		}
		var in wire.ComputerConnectorVerificationQuery
		if json.Unmarshal(request.Body, &in) != nil {
			return invalidIngress()
		}
		if err := s.enter(ctx); err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		defer func() { <-s.effects }()
		slot := s.current
		if slot == nil || expected != nil && slot != expected || slot.closing || slot.startupUncertain || in.Binding != slot.opened.Endpoint.Binding {
			return connectorVerificationOutcome(nil, computerUnavailable())
		}
		lease, err := slot.route.admitCatalogue(ctx)
		if err != nil {
			return connectorVerificationOutcome(nil, err)
		}
		state, err := connectorVerificationState(ctx, slot, lease)
		return connectorVerificationOutcome(state, err)
	}}
}
