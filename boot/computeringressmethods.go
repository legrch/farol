package boot

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

func ingressOutcome(value any, err error) (*desktop.Outcome, error) {
	if err != nil {
		var failure *authority.Failure
		if errors.As(err, &failure) {
			return &desktop.Outcome{Status: "refused", Code: failure.Code}, nil
		}
		// Unclassified/possibly published effects are unknown, never clean absence.
		return nil, err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return &desktop.Outcome{Status: "ok", Data: raw}, nil
}
func invalidIngress() (*desktop.Outcome, error) {
	return &desktop.Outcome{Status: "refused", Code: "invalid_ingress_request"}, nil
}

// Register all methods once before Server.New copies the registry. The holder
// selects only a route minted by this root's known publication+actual admission;
// body IDs and the presence of a registered read capability create no authority.
func (s *ComputerIngress) Methods() map[string]desktop.Method {
	methods := map[string]desktop.Method{
		"computer.authority.deactivate": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerAuthorityDeactivateRequest", r.Body) != nil {
				return invalidIngress()
			}
			value, err := s.Deactivate(ctx, r.OperationID)
			return ingressOutcome(value, err)
		}},
		"computer.authority.publish": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ComputerAuthorityPublishRequest", r.Body) != nil {
				return invalidIngress()
			}
			var body wire.ComputerAuthorityPublishRequest
			if json.Unmarshal(r.Body, &body) != nil {
				return invalidIngress()
			}
			// Reject the closed existing projection before either root claim or native IO.
			if _, err := parseDesktopApproval(body.Approval, s.ownerID, s.computerID); err != nil {
				return invalidIngress()
			}
			value, err := s.Publish(ctx, r.OperationID, body)
			return ingressOutcome(value, err)
		}},
		"chat.turn": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil || wire.Validate("ChatComputerAdmissionRequest", r.Body) != nil {
				return invalidIngress()
			}
			var body wire.ChatComputerAdmissionRequest
			if json.Unmarshal(r.Body, &body) != nil {
				return invalidIngress()
			}
			value, err := s.Admit(ctx, r.OperationID, body)
			return ingressOutcome(value, err)
		}},
	}
	// Selector closures capture the actual holder, not a nil startup route or a
	// mutable method map; the selected route itself rechecks its immutable fence.
	for _, name := range []string{"computer.workspace.catalogue", "computer.workspace.bootstrap", "computer.workspace.read"} {
		methods[name] = desktop.Method{Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			selected, err := s.selectedRoute()
			if err != nil {
				var failure *workspacect.Failure
				if errors.As(err, &failure) {
					return &desktop.Outcome{Status: "unavailable", Code: failure.Code}, nil
				}
				return nil, err
			}
			return selected.Methods(s.peer)[name].Handle(ctx, r)
		}}
	}
	return methods
}
