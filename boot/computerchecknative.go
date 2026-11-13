package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strconv"

	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	check "github.com/legrch/farol/modules/computer/domain/connector"
)

// CurrentConnectionCheck is a fresh Go verification-owner observation. It
// provides only matching runtime/proof values; cached Settings/renderer state
// cannot mint an already-verified Go challenge receipt.
func (s *computerConnector) CurrentConnectionCheck(ctx context.Context) (connectorsvc.ConnectionCheckBinding, error) {
	var out connectorsvc.ConnectionCheckBinding
	if err := s.enter(ctx); err != nil {
		return out, err
	}
	defer func() { <-s.effects }()
	slot := s.current
	if slot == nil || slot.closing || slot.startupUncertain || slot.owner == nil ||
		slot.challengeDigest == "" || slot.opened.Endpoint.Binding.RuntimeId == "" {
		return out, computerUnavailable()
	}
	status, err := s.root.store.Status(ctx)
	if err != nil || !status.ApprovalPresent {
		return out, computerUnavailable()
	}
	b := slot.opened.Endpoint.Binding
	out = connectorsvc.ConnectionCheckBinding{
		BuildID: b.BuildId, BackendGeneration: b.BackendGeneration,
		RuntimeID: b.RuntimeId, ConnectorGeneration: b.ConnectorGeneration,
		ComputerGeneration: strconv.FormatUint(status.Generation, 10),
		ChallengeDigest:    slot.challengeDigest,
	}
	proof, err := slot.owner.CurrentVerification(ctx)
	if err != nil {
		return connectorsvc.ConnectionCheckBinding{}, err
	}
	if proof != nil {
		raw, e := json.Marshal(proof)
		if e != nil {
			return connectorsvc.ConnectionCheckBinding{}, computerUnavailable()
		}
		sum := sha256.Sum256(raw)
		out.ProofCurrent = true
		out.ProofDigest = hex.EncodeToString(sum[:])
		out.ProofWorkspaceID = proof.WorkspaceID
		if out.ChallengeDigest != hex.EncodeToString(proof.ChallengeDigest[:]) {
			return connectorsvc.ConnectionCheckBinding{}, computerUnavailable()
		}
	}
	return out, nil
}

// ArmOriginalStatusCheck is invoked only once after the *existing protected*
// Access Store confirmed original dispatch intent. The socket cannot arm this
// ID by making a status read. Bootstrap arms the parent without a status nonce
// and preserves the old one-shot challenge verification owner.
func (s *computerConnector) ArmOriginalStatusCheck(ctx context.Context, parentID, checkID string, scope check.Scope) error {
	if !check.ValidScope(scope) || scope.DocumentDigest == "" || parentID == "" {
		return computerUnavailable()
	}
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer func() { <-s.effects }()
	status, err := s.root.store.Status(ctx)
	if err != nil || !status.ApprovalPresent || strconv.FormatUint(status.Generation, 10) != scope.ComputerGeneration {
		return computerUnavailable()
	}
	slot := s.current
	// A newer owner check replaces an earlier one that never confirmed in this
	// slot; the Store has already settled that earlier record as unknown.
	if slot == nil || slot.closing || slot.startupUncertain || slot.owner == nil ||
		slot.checkParentID == parentID || scope.CheckID != checkID ||
		scope.ChallengeDigest != slot.challengeDigest {
		return computerUnavailable()
	}
	b := slot.opened.Endpoint.Binding
	if b.BuildId != scope.BuildID || b.BackendGeneration != scope.BackendGeneration ||
		b.RuntimeId != scope.RuntimeID || b.ConnectorGeneration != scope.ConnectorGeneration {
		return computerUnavailable()
	}
	proof, err := slot.owner.CurrentVerification(ctx)
	if err != nil {
		return err
	}
	if scope.Mode == check.Status {
		if proof == nil || checkID == "" || scope.AttachmentDigest == "" {
			return computerUnavailable()
		}
		raw, e := json.Marshal(proof)
		if e != nil {
			return computerUnavailable()
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != scope.AttachmentDigest ||
			proof.WorkspaceID != scope.WorkspaceID ||
			hex.EncodeToString(proof.ChallengeDigest[:]) != scope.ChallengeDigest {
			return computerUnavailable()
		}
		slot.expectedStatusCheckID = checkID
		slot.statusCheckID = ""
		slot.statusSendRecorded = false
	} else if scope.Mode == check.Bootstrap {
		if proof != nil || checkID != "" || scope.Challenge == "" {
			return computerUnavailable()
		}
	} else {
		return computerUnavailable()
	}
	if scope.Mode == check.Bootstrap {
		slot.expectedStatusCheckID = ""
		slot.statusCheckID = ""
		slot.statusSendRecorded = false
	}
	// This is a transient original-runtime dispatch right. Restart cannot
	// reconstruct it from the durable record or repeat the source Send.
	slot.checkParentID = parentID
	return nil
}

// RecordOriginalStatusSend is invoked only after the Access Store durably
// recorded that the browser clicked Send for this exact armed status check.
// Before it, an argument-free status call cannot be this check's prompt: it
// opens the only window in which such a call may acknowledge the check.
// Bootstrap has no status acknowledgement and records nothing.
func (s *computerConnector) RecordOriginalStatusSend(ctx context.Context, parentID string, scope check.Scope) error {
	if scope.Mode != check.Status {
		return nil
	}
	if !check.ValidScope(scope) || scope.CheckID == "" || parentID == "" {
		return computerUnavailable()
	}
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer func() { <-s.effects }()
	slot := s.current
	if slot == nil || slot.closing || slot.startupUncertain ||
		slot.checkParentID != parentID || slot.expectedStatusCheckID != scope.CheckID {
		return computerUnavailable()
	}
	slot.statusSendRecorded = true
	return nil
}

// ConfirmOriginalConnectionCheck supplies the sole positive Go-side receipt.
// For status, a public MCP computer_connection_status call must have reached
// this exact socket and current Go slot: either with this check's exact ID,
// or argument-free after this check's own Send was durably recorded.
// Bootstrap retains the original sealed challenge/List or empty Catalogue.
func (s *computerConnector) ConfirmOriginalConnectionCheck(ctx context.Context, parentID string, scope check.Scope) (string, error) {
	if !check.ValidScope(scope) || scope.DocumentDigest == "" {
		return "", computerUnavailable()
	}
	if err := s.enter(ctx); err != nil {
		return "", err
	}
	defer func() { <-s.effects }()
	status, err := s.root.store.Status(ctx)
	if err != nil || !status.ApprovalPresent || strconv.FormatUint(status.Generation, 10) != scope.ComputerGeneration {
		return "", computerUnavailable()
	}
	slot := s.current
	if slot == nil || slot.closing || slot.startupUncertain ||
		slot.checkParentID != parentID || scope.ChallengeDigest != slot.challengeDigest {
		return "", computerUnavailable()
	}
	b := slot.opened.Endpoint.Binding
	if b.BuildId != scope.BuildID || b.BackendGeneration != scope.BackendGeneration ||
		b.RuntimeId != scope.RuntimeID || b.ConnectorGeneration != scope.ConnectorGeneration {
		return "", computerUnavailable()
	}
	proof, err := slot.owner.CurrentVerification(ctx)
	if err != nil || proof == nil {
		return "", computerUnavailable()
	}
	if proof.WorkspaceID != scope.WorkspaceID ||
		hex.EncodeToString(proof.ChallengeDigest[:]) != scope.ChallengeDigest {
		return "", computerUnavailable()
	}
	if scope.Mode == check.Status {
		raw, e := json.Marshal(proof)
		if e != nil {
			return "", computerUnavailable()
		}
		d := sha256.Sum256(raw)
		if hex.EncodeToString(d[:]) != scope.AttachmentDigest ||
			scope.CheckID == "" || scope.CheckID != slot.expectedStatusCheckID ||
			scope.CheckID != slot.statusCheckID {
			return "", computerUnavailable()
		}
	} else if scope.Mode != check.Bootstrap {
		return "", computerUnavailable()
	}
	proofRaw, err := json.Marshal(proof)
	if err != nil {
		return "", computerUnavailable()
	}
	proofDigest := sha256.Sum256(proofRaw)
	correlation := struct {
		ParentID      string `json:"parentOperationId"`
		ScopeDigest   string `json:"scopeDigest"`
		CheckID       string `json:"checkId"`
		GoProofDigest string `json:"goProofDigest"`
		RuntimeID     string `json:"runtimeId"`
	}{
		parentID, scope.ScopeDigest, scope.CheckID,
		hex.EncodeToString(proofDigest[:]), b.RuntimeId,
	}
	raw, err := json.Marshal(correlation)
	if err != nil {
		return "", computerUnavailable()
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// Trusted application-owner callback only, after VERIFIED was durably published.
// No socket, observation, timeout or UNKNOWN path can retire this expectation.
func (s *computerConnector) RetireOriginalConnectionCheck(ctx context.Context, parentID string, scope check.Scope) error {
	if err := s.enter(ctx); err != nil {
		return err
	}
	defer func() { <-s.effects }()
	slot := s.current
	if slot == nil || slot.checkParentID != parentID || slot.opened.Endpoint.Binding.RuntimeId != scope.RuntimeID ||
		slot.opened.Endpoint.Binding.BackendGeneration != scope.BackendGeneration || slot.expectedStatusCheckID != scope.CheckID {
		return computerUnavailable()
	}
	slot.checkParentID = ""
	slot.expectedStatusCheckID = ""
	slot.statusCheckID = ""
	slot.statusSendRecorded = false
	return nil
}
