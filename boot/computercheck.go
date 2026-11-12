package boot

import (
	"context"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	check "github.com/legrch/farol/modules/computer/domain/connector"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

type explicitCheckClaim struct {
	OperationID string `json:"operationId"`
	Fingerprint string `json:"fingerprint"`
}
type explicitCheckPrepare struct {
	OperationID string `json:"operationId"`
	connectorsvc.ConnectionCheckSelection
}
type explicitCheckAdvance struct {
	OperationID string `json:"operationId"`
	Stage       string `json:"stage"`
}
type explicitCheckObserve struct {
	OperationID string `json:"operationId"`
}

func connectionCheckOutcome(value any, err error) (*desktop.Outcome, error) {
	switch {
	case errors.Is(err, check.ErrRefused):
		return &desktop.Outcome{Status: "refused", Code: "computer_connection_check_refused"}, nil
	case errors.Is(err, check.ErrPending):
		return &desktop.Outcome{Status: "refused", Code: "computer_connection_check_pending"}, nil
	case errors.Is(err, check.ErrCapacity):
		return &desktop.Outcome{Status: "refused", Code: "computer_connection_check_capacity"}, nil
	case errors.Is(err, check.ErrUnknown):
		return &desktop.Outcome{Status: "unknown", Code: "computer_connection_check_unknown"}, nil
	default:
		// An unexpected native, journal or publication error does not prove
		// that a known effect was not dispatched.
		return ingressOutcome(value, err)
	}
}
func checkPrepareResponse(e check.Entry, prompt string) any {
	var checkID *string
	if e.Scope != nil && e.Scope.CheckID != "" {
		id := e.Scope.CheckID
		checkID = &id
	}
	return struct {
		OperationID    string  `json:"operationId"`
		Phase          string  `json:"phase"`
		Mode           string  `json:"mode"`
		CheckID        *string `json:"checkId,omitempty"`
		Prompt         string  `json:"prompt"`
		PromptDigest   string  `json:"promptDigest"`
		ScopeDigest    string  `json:"scopeDigest"`
		DocumentDigest string  `json:"documentDigest"`
	}{
		OperationID: e.Request.OperationID, Phase: string(e.Phase),
		Mode: string(e.Scope.Mode), CheckID: checkID, Prompt: prompt,
		PromptDigest: e.Scope.PromptDigest, ScopeDigest: e.Scope.ScopeDigest, DocumentDigest: e.Scope.DocumentDigest,
	}
}
func checkObserveResponse(e check.Entry, available bool) any {
	var mode, checkID, receipt *string
	if e.Scope != nil {
		m := string(e.Scope.Mode)
		mode = &m
		if e.Scope.CheckID != "" {
			id := e.Scope.CheckID
			checkID = &id
		}
	}
	if e.Receipt != nil {
		r := e.Receipt.Digest
		receipt = &r
	}
	return struct {
		OperationID      string  `json:"operationId"`
		Phase            string  `json:"phase"`
		Mode             *string `json:"mode,omitempty"`
		CheckID          *string `json:"checkId,omitempty"`
		ReceiptDigest    *string `json:"receiptDigest,omitempty"`
		Delivery         string  `json:"delivery"`
		ReceiptAvailable bool    `json:"receiptAvailable"`
	}{
		OperationID: e.Request.OperationID, Phase: string(e.Phase),
		Mode: mode, CheckID: checkID, ReceiptDigest: receipt, Delivery: "not_recorded", ReceiptAvailable: available,
	}
}
func checkAdvanceResponse(e check.Entry, send bool) any {
	var receipt *string
	if e.Receipt != nil {
		id := e.Receipt.Digest
		receipt = &id
	}
	return struct {
		OperationID    string  `json:"operationId"`
		Phase          string  `json:"phase"`
		SendAuthorized bool    `json:"sendAuthorized"`
		ReceiptDigest  *string `json:"receiptDigest,omitempty"`
	}{e.Request.OperationID, string(e.Phase), send, receipt}
}

// An explicit owner-clicked request is the sole source of connection-check
// UUID. Every subsequent phase is a separate RPC effect, while the original
// parent identity stays immutable. No RPC takes browser/native callbacks under
// the protected Go Store lock. These methods never Send.
func (s *ComputerIngress) connectionCheckMethods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"computer.check.claim": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil ||
				wire.Validate("ComputerCheckClaimRequest", r.Body) != nil {
				return invalidIngress()
			}
			var req explicitCheckClaim
			if json.Unmarshal(r.Body, &req) != nil || req.OperationID != r.OperationID {
				return invalidIngress()
			}
			if s == nil || s.checkOwner == nil {
				return nil, computerUnavailable()
			}
			e, first, err := s.checkOwner.Claim(ctx, req.OperationID, req.Fingerprint)
			if err != nil {
				return connectionCheckOutcome(nil, err)
			}
			return connectionCheckOutcome(struct {
				OperationID string `json:"operationId"`
				Phase       string `json:"phase"`
				First       bool   `json:"first"`
			}{e.Request.OperationID, string(e.Phase), first}, nil)
		}},
		"computer.check.prepare": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil ||
				wire.Validate("ComputerCheckPrepareRequest", r.Body) != nil {
				return invalidIngress()
			}
			var req struct {
				OperationID        string     `json:"operationId"`
				Mode               check.Mode `json:"mode"`
				AppName            string     `json:"appName"`
				Model              string     `json:"model"`
				TunnelID           string     `json:"tunnelId"`
				WorkspaceID        string     `json:"workspaceId,omitempty"`
				Challenge          string     `json:"challenge,omitempty"`
				ChallengeDigest    string     `json:"challengeDigest"`
				AttachmentDigest   string     `json:"attachmentDigest,omitempty"`
				ComputerGeneration string     `json:"computerGeneration"`
				DocumentDigest     string     `json:"documentDigest"`
			}
			if json.Unmarshal(r.Body, &req) != nil || req.OperationID == r.OperationID || req.OperationID == "" {
				return invalidIngress()
			}
			if s == nil || s.checkOwner == nil {
				return nil, computerUnavailable()
			}
			e, prompt, err := s.checkOwner.Prepare(ctx, req.OperationID, connectorsvc.ConnectionCheckSelection{
				Mode: req.Mode, AppName: req.AppName, Model: req.Model,
				TunnelID: req.TunnelID, WorkspaceID: req.WorkspaceID,
				Challenge: req.Challenge, ChallengeDigest: req.ChallengeDigest,
				AttachmentDigest:   req.AttachmentDigest,
				ComputerGeneration: req.ComputerGeneration, DocumentDigest: req.DocumentDigest,
			})
			if err != nil {
				return connectionCheckOutcome(nil, err)
			}
			return connectionCheckOutcome(checkPrepareResponse(e, prompt), nil)
		}},
		"computer.check.advance": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID == "" || ipc.ValidateJSON(r.Body) != nil ||
				wire.Validate("ComputerCheckAdvanceRequest", r.Body) != nil {
				return invalidIngress()
			}
			var req explicitCheckAdvance
			if json.Unmarshal(r.Body, &req) != nil || req.OperationID == "" || req.OperationID == r.OperationID {
				return invalidIngress()
			}
			if s == nil || s.checkOwner == nil {
				return nil, computerUnavailable()
			}
			var e check.Entry
			var err error
			var authorized bool
			switch req.Stage {
			case "dispatch":
				e, err = s.checkOwner.Arm(ctx, req.OperationID)
				authorized = err == nil
			case "sent":
				e, err = s.checkOwner.RetainSend(ctx, req.OperationID, true)
			case "unknown":
				e, err = s.checkOwner.RetainSend(ctx, req.OperationID, false)
			case "confirm":
				e, err = s.checkOwner.Confirm(ctx, req.OperationID)
			case "refuse":
				e, err = s.checkOwner.RefuseBeforeDispatch(ctx, req.OperationID)
			default:
				return invalidIngress()
			}
			if err != nil {
				return connectionCheckOutcome(nil, err)
			}
			return connectionCheckOutcome(checkAdvanceResponse(e, authorized), nil)
		}},
		"computer.check.observe": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			if r.OperationID != "" || ipc.ValidateJSON(r.Body) != nil ||
				wire.Validate("ComputerCheckObserveRequest", r.Body) != nil {
				return invalidIngress()
			}
			var req explicitCheckObserve
			if json.Unmarshal(r.Body, &req) != nil || req.OperationID == "" {
				return invalidIngress()
			}
			if s == nil || s.checkOwner == nil {
				return nil, computerUnavailable()
			}
			e, err := s.checkOwner.Observe(ctx, req.OperationID)
			if err != nil {
				return connectionCheckOutcome(nil, err)
			}
			available := s.checkOwner.ReceiptAvailable(ctx, req.OperationID)
			return connectionCheckOutcome(checkObserveResponse(e, available), nil)
		}},
	}
}
