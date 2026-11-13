package boot

import (
	"errors"
	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
)

// Wire arrays keep generated boundaries closed. Reject duplicate names before
// mapping into the existing policy's maps; never let last-wins change meaning.
func chatModelPolicy(policy wire.ChatModelPolicy, sourceProfiles []wire.ChatBrowserModelProfile) (chatport.ModelPolicy, []chatport.BrowserModelProfile, error) {
	invalid := errors.New("chat_model_selection_invalid")
	p := chatport.ModelPolicy{DefaultHarness: policy.DefaultHarness, Harnesses: make(map[string]chatport.ModelHarnessPolicy)}
	if len(policy.Harnesses) < 1 || len(policy.Harnesses) > 16 || len(sourceProfiles) < 1 || len(sourceProfiles) > 128 {
		return p, nil, invalid
	}
	for _, h := range policy.Harnesses {
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
	profiles := make([]chatport.BrowserModelProfile, 0, len(sourceProfiles))
	for _, profile := range sourceProfiles {
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
