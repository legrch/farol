// Package modelselection resolves existing settings.tasks through an explicitly
// supported compiled browser route. It owns no settings, registry or executor.
package modelselection

import (
	"encoding/json"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/port"
)

type Code string

func (c Code) Error() string { return string(c) }

const (
	ConfigInvalid      Code = "CHAT_MODEL_CONFIG_INVALID"
	RequestInvalid     Code = "CHAT_MODEL_REQUEST_INVALID"
	HarnessMissing     Code = "CHAT_MODEL_HARNESS_MISSING"
	HarnessUnsupported Code = "CHAT_MODEL_HARNESS_UNSUPPORTED"
	ModelMissing       Code = "CHAT_MODEL_MISSING"
	ProfileInvalid     Code = "CHAT_MODEL_PROFILE_INVALID"
	ProfileUnsupported Code = "CHAT_MODEL_PROFILE_UNSUPPORTED"
	ProfileAmbiguous   Code = "CHAT_MODEL_PROFILE_AMBIGUOUS"
	EffortUnsupported  Code = "CHAT_MODEL_EFFORT_UNSUPPORTED"
	ModeMismatch       Code = "CHAT_MODEL_MODE_MISMATCH"
	DigestUnavailable  Code = "CHAT_MODEL_DIGEST_UNAVAILABLE"
)

// Resolve performs no host IO, crypto, clock read or provider effect. The
// digester is called once, only after selection validation, with exact canonical
// taskPolicyIdentity bytes. Inputs must not be concurrently mutated during the
// call. The returned value retains no input maps, slices or pointers.
func Resolve(digests port.IntentDigester, policy port.ModelPolicy, requested port.ModelRequest, profiles []port.BrowserModelProfile, accountID string) (*port.ModelSelectionCapture, error) {
	if !validPolicy(policy) {
		return nil, ConfigInvalid
	}
	if !optional(requested.Harness, taskName) || !optional(requested.Model, taskName) || !optional(requested.Effort, effortName) || !optional(requested.RequestedMode, requestedMode) || !opaqueID(accountID) {
		return nil, RequestInvalid
	}
	executor := fallback(requested.Harness, policy.DefaultHarness)
	harness, exists := policy.Harnesses[executor]
	if !exists {
		return nil, HarnessMissing
	}
	// Validate supplied compiled metadata, including unrelated rows and unique
	// translation IDs. A malformed row must not make order influence selection.
	ids := make(map[string]bool, len(profiles))
	supported := false
	for _, p := range profiles {
		if !validProfile(p) {
			return nil, ProfileInvalid
		}
		if ids[p.ID] {
			return nil, ProfileAmbiguous
		}
		ids[p.ID] = true
		supported = supported || p.Executor == executor
	}
	if !supported {
		return nil, HarnessUnsupported
	}
	alias := fallback(requested.Model, harness.DefaultModel)
	model, exists := harness.Models[alias]
	if !exists {
		return nil, ModelMissing
	}
	var selected *port.BrowserModelProfile
	for n := range profiles {
		p := &profiles[n]
		if p.Executor == executor && p.RuntimeModel == model.Model {
			if selected != nil {
				return nil, ProfileAmbiguous
			}
			selected = p
		}
	}
	if selected == nil || selected.Required.Connector {
		return nil, ProfileUnsupported
	}
	p := *selected
	if requested.RequestedMode != nil && *requested.RequestedMode != p.Mode {
		return nil, ModeMismatch
	}
	inputEffort := requested.Effort
	if inputEffort == nil {
		inputEffort = model.DefaultEffort
	}
	effort := p.DefaultEffort
	if inputEffort != nil {
		effort = ""
		for _, pair := range p.Efforts {
			if pair.Requested == *inputEffort {
				effort = pair.Resolved
				break
			}
		}
	}
	if effort == "" {
		return nil, EffortUnsupported
	}
	selection := port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: strings.Clone(accountID), ModelID: strings.Clone(p.ModelID), Effort: strings.Clone(effort), Mode: strings.Clone(p.Mode)}
	if !selection.Valid() || !p.Required.Valid(selection) {
		return nil, ProfileInvalid
	}
	if digests == nil {
		return nil, DigestUnavailable
	}
	identity, err := canonicalPolicy(policy)
	if err != nil {
		return nil, ConfigInvalid
	}
	resolution := port.ModelResolution{RequestedAlias: strings.Clone(alias), RequestedExecutor: strings.Clone(executor), RequestedEffort: strings.Clone(fallback(requested.Effort, "")), RequestedMode: strings.Clone(fallback(requested.RequestedMode, "")), Resolved: selection, TranslationID: strings.Clone(p.ID)}
	digest, err := digests.Digest(identity)
	if err != nil {
		return nil, DigestUnavailable
	}
	resolution.ConfigSHA256 = strings.Clone(digest)
	if !resolution.Valid(selection) {
		return nil, DigestUnavailable
	}
	return &port.ModelSelectionCapture{Selection: selection, Resolution: resolution, Required: p.Required}, nil
}

func validPolicy(p port.ModelPolicy) bool {
	if !taskName(p.DefaultHarness) || len(p.Harnesses) < 1 || len(p.Harnesses) > 16 {
		return false
	}
	if _, exists := p.Harnesses[p.DefaultHarness]; !exists {
		return false
	}
	for name, harness := range p.Harnesses {
		if !taskName(name) || !taskName(harness.DefaultModel) || len(harness.Models) < 1 || len(harness.Models) > 64 {
			return false
		}
		if _, exists := harness.Models[harness.DefaultModel]; !exists {
			return false
		}
		for alias, model := range harness.Models {
			if !taskName(alias) || !runtimeModel(model.Model) || !optional(model.DefaultEffort, effortName) {
				return false
			}
		}
	}
	return true
}

func validProfile(p port.BrowserModelProfile) bool {
	if !opaqueID(p.ID) || !taskName(p.Executor) || !runtimeModel(p.RuntimeModel) || !opaqueID(p.ModelID) || !profileMode(p.Mode) || !p.Required.Model || p.Required.Mode != (p.Mode != "") || len(p.Efforts) == 0 {
		return false
	}
	names := make(map[string]bool, len(p.Efforts))
	defaultSupported := p.DefaultEffort == ""
	for _, pair := range p.Efforts {
		if !effortName(pair.Requested) || !effortName(pair.Resolved) || names[pair.Requested] {
			return false
		}
		names[pair.Requested] = true
		defaultSupported = defaultSupported || pair.Resolved == p.DefaultEffort
	}
	return defaultSupported
}

// All policy strings are restricted ASCII, so json.Marshal has the same string
// bytes as JSON.stringify (no HTML escaping or Unicode sorting differences).
// Empty arrays must be [] and absent defaultEffort must be null, never omitted.
func canonicalPolicy(p port.ModelPolicy) ([]byte, error) {
	names := make([]string, 0, len(p.Harnesses))
	for name := range p.Harnesses {
		names = append(names, name)
	}
	sort.Strings(names)
	harnesses := make([]any, 0, len(names))
	for _, name := range names {
		h := p.Harnesses[name]
		aliases := make([]string, 0, len(h.Models))
		for alias := range h.Models {
			aliases = append(aliases, alias)
		}
		sort.Strings(aliases)
		models := make([]any, 0, len(aliases))
		for _, alias := range aliases {
			m := h.Models[alias]
			models = append(models, []any{alias, m.Model, m.DefaultEffort})
		}
		harnesses = append(harnesses, []any{name, h.DefaultModel, models})
	}
	return json.Marshal([]any{"farol-task-policy/1", p.DefaultHarness, harnesses})
}

func optional(value *string, valid func(string) bool) bool { return value == nil || valid(*value) }
func fallback(value *string, otherwise string) string {
	if value != nil {
		return *value
	}
	return otherwise
}
func lowerDigit(c byte) bool { return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' }
func taskName(s string) bool {
	if len(s) < 1 || len(s) > 80 || s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for n := 1; n < len(s); n++ {
		if lowerDigit(s[n]) {
			continue
		}
		if (s[n] != '-' && s[n] != '_' && s[n] != '.') || n+1 == len(s) || !lowerDigit(s[n+1]) {
			return false
		}
	}
	return true
}
func effortName(s string) bool {
	if len(s) < 1 || len(s) > 40 {
		return false
	}
	for n := range len(s) {
		c := s[n]
		if !lowerDigit(c) && !(c >= 'A' && c <= 'Z') && c != '_' && c != '-' {
			return false
		}
	}
	return true
}
func runtimeModel(s string) bool {
	if len(s) < 1 || len(s) > 120 {
		return false
	}
	for n := range len(s) {
		c := s[n]
		if !lowerDigit(c) && !(c >= 'A' && c <= 'Z') && c != '_' && c != '-' && c != '.' && c != '/' {
			return false
		}
	}
	return true
}
func opaqueID(s string) bool {
	if len(s) < 1 || len(s) > 120 || !utf8.ValidString(s) {
		return false
	}
	for _, c := range s {
		if c <= 32 || c == 127 {
			return false
		}
	}
	return true
}
func profileMode(s string) bool   { return s == "" || requestedMode(s) }
func requestedMode(s string) bool { return s == "standard" || s == "pro" }
