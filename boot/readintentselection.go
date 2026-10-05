package boot

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/modelselection"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// Trusted host composition supplies existing settings.tasks and compiled route
// metadata. Neither is an account grant or a provider observation. The original
// owner captures one detached selection before promotion/queue admission.
func (s *ComputerIngress) resolveRead(ctx context.Context, operation string, in wire.ChatReadIntentResolve) (*wire.ChatReadIntentResolved, error) {
	s.effects.Lock()
	defer s.effects.Unlock()
	if ctx == nil || ctx.Err() != nil || !validIngressID(operation) || validateIngress("ChatReadIntentResolve", in) != nil {
		return nil, readAccountRefusal("read_intent_selection_invalid")
	}
	c, err := s.capturedRead(in.Admission)
	if err != nil {
		return nil, err
	}
	if c.withdrawn || c.accountRevoked || c.account == nil || c.accountReceipt == nil {
		return nil, readAccountRefusal("read_intent_account_not_approved")
	}
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, readAccountRefusal("read_intent_selection_invalid")
	}
	inputDigest := sha256.Sum256(raw)
	if c.modelCapture != nil {
		if c.modelInput != inputDigest {
			return nil, readAccountRefusal("read_intent_selection_conflict")
		}
		out := *c.modelCapture
		return &out, nil
	}
	if c.promoted != nil {
		return nil, readAccountRefusal("read_intent_already_promoted")
	}
	s.guard.mu.Lock()
	current := s.guard.active && !s.guard.exhausted && s.guard.revision == c.fence
	s.guard.mu.Unlock()
	if !current {
		return nil, readAccountRefusal("read_intent_authority_withdrawn")
	}
	policy, profiles, err := readModelPolicy(in)
	if err != nil {
		return nil, err
	}
	requested := in.Requested
	capture, err := modelselection.Resolve(intent.SHA256{}, policy, chatport.ModelRequest{Harness: requested.Harness, Model: requested.Model, Effort: requested.Effort, RequestedMode: requested.Mode}, profiles, c.accountReceipt.PrincipalKey)
	if err != nil {
		return nil, readAccountRefusal(err.Error())
	}
	if ctx.Err() != nil {
		return nil, readAccountRefusal("read_intent_selection_expired")
	}
	if err = s.claim(operation); err != nil {
		return nil, err
	}
	selection := capture.Selection
	resolved := wire.BrowserSelection{Provider: selection.Provider, Alias: selection.Alias, AccountId: selection.AccountID, ModelId: selection.ModelID, Effort: selection.Effort, Mode: selection.Mode, ToolsEnabled: selection.ToolsEnabled, ConnectorId: selection.ConnectorID, ConnectorGrantId: selection.ConnectorGrantID}
	resolution := capture.Resolution
	out := wire.ChatReadIntentResolved{Admission: in.Admission, Selection: resolved, Resolution: wire.BrowserResolution{RequestedAlias: resolution.RequestedAlias, RequestedExecutor: resolution.RequestedExecutor, RequestedEffort: resolution.RequestedEffort, RequestedMode: resolution.RequestedMode, Resolved: resolved, ConfigSHA256: resolution.ConfigSHA256, TranslationId: resolution.TranslationID}, Required: wire.BrowserRequiredControls{Model: capture.Required.Model, Effort: capture.Required.Effort, Mode: capture.Required.Mode, Connector: capture.Required.Connector}}
	if validateIngress("ChatReadIntentResolved", out) != nil {
		return nil, readAccountRefusal("read_intent_selection_invalid")
	}
	// Retain the detached output and canonical request digest, not another full
	// configuration snapshot per owner. Wire arrays retain order in this digest.
	c.modelInput = inputDigest
	c.modelCapture = &out
	// Lost/late publication cannot be upgraded by a fresh resolver attempt.
	s.guard.mu.Lock()
	current = s.guard.active && !s.guard.exhausted && s.guard.revision == c.fence
	s.guard.mu.Unlock()
	if ctx.Err() != nil || !current {
		s.poison()
		return nil, errors.New("read_intent_selection_unconfirmed")
	}
	reply := out
	return &reply, nil
}

func readModelPolicy(in wire.ChatReadIntentResolve) (chatport.ModelPolicy, []chatport.BrowserModelProfile, error) {
	policy, profiles, err := chatModelPolicy(in.Policy, in.Profiles)
	if err != nil {
		return policy, nil, readAccountRefusal("read_intent_selection_invalid")
	}
	return policy, profiles, nil
}
