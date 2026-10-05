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

// Wire arrays keep generated boundaries closed. Reject duplicate names before
// mapping into the existing policy's maps; never let last-wins change meaning.
func readModelPolicy(in wire.ChatReadIntentResolve) (chatport.ModelPolicy, []chatport.BrowserModelProfile, error) {
	invalid := readAccountRefusal("read_intent_selection_invalid")
	p := chatport.ModelPolicy{DefaultHarness: in.Policy.DefaultHarness, Harnesses: make(map[string]chatport.ModelHarnessPolicy)}
	if len(in.Policy.Harnesses) < 1 || len(in.Policy.Harnesses) > 16 || len(in.Profiles) < 1 || len(in.Profiles) > 128 {
		return p, nil, invalid
	}
	for _, h := range in.Policy.Harnesses {
		if _, exists := p.Harnesses[h.Name]; exists || len(h.Models) < 1 || len(h.Models) > 64 {
			return p, nil, invalid
		}
		mapped := chatport.ModelHarnessPolicy{DefaultModel: h.DefaultModel, Models: make(map[string]chatport.ConfiguredModel)}
		for _, m := range h.Models {
			if _, exists := mapped.Models[m.Alias]; exists {
				return p, nil, invalid
			}
			mapped.Models[m.Alias] = chatport.ConfiguredModel{Model: m.Model, DefaultEffort: m.DefaultEffort}
		}
		p.Harnesses[h.Name] = mapped
	}
	profiles := make([]chatport.BrowserModelProfile, 0, len(in.Profiles))
	for _, profile := range in.Profiles {
		if len(profile.Efforts) < 1 || len(profile.Efforts) > 32 {
			return p, nil, invalid
		}
		pairs := make([]chatport.BrowserModelEffort, 0, len(profile.Efforts))
		for _, pair := range profile.Efforts {
			pairs = append(pairs, chatport.BrowserModelEffort{Requested: pair.Requested, Resolved: pair.Resolved})
		}
		profiles = append(profiles, chatport.BrowserModelProfile{ID: profile.Id, Executor: profile.Executor, RuntimeModel: profile.RuntimeModel, ModelID: profile.ModelId, DefaultEffort: profile.DefaultEffort, Mode: profile.Mode, Efforts: pairs, Required: chatport.RequiredControls{Model: profile.Required.Model, Effort: profile.Required.Effort, Mode: profile.Required.Mode, Connector: profile.Required.Connector}})
	}
	return p, profiles, nil
}
