// Package modelpolicy resolves configured Task model choices without executing
// a harness or inferring catalogue, account or permission facts.
package modelpolicy

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/legrch/farol/modules/task/app/port"
)

const MaxPolicyBytes = 1 << 20
const MaxSelectionBytes = 4096

type Status string

const (
	Ready              Status = "ready"
	ConfigMissing      Status = "config-missing"
	ConfigInvalid      Status = "config-invalid"
	SelectionInvalid   Status = "selection-invalid"
	HarnessMissing     Status = "harness-missing"
	HarnessUnsupported Status = "harness-unsupported"
	ModelMissing       Status = "model-missing"
	Unavailable        Status = "unavailable"
)

type Selection struct {
	Harness    string  `json:"harness"`
	ModelAlias string  `json:"modelAlias"`
	Model      string  `json:"model"`
	Effort     *string `json:"effort,omitempty"`
}

type Resolution struct {
	Status       Status     `json:"status"`
	Selection    *Selection `json:"selection,omitempty"`
	ConfigSHA256 string     `json:"configSha256,omitempty"`
}

type Service struct {
	decoder   port.TaskModelPolicyDecoder
	digester  port.TaskModelPolicyDigester
	supported []string
}

// New receives trusted, concurrency-safe adapters; their interface values must
// not contain nil concrete pointers. An absent interface fails unavailable.
func New(decoder port.TaskModelPolicyDecoder, digester port.TaskModelPolicyDigester, supportedHarnesses []string) *Service {
	supported := make([]string, len(supportedHarnesses))
	for i, value := range supportedHarnesses {
		supported[i] = strings.Clone(value)
	}
	return &Service{decoder: decoder, digester: digester, supported: supported}
}

// Resolve uses one snapshot and preserves the TypeScript resolver's refusal
// ordering. Raw wire limits include whitespace and are intentionally narrower
// than an already-parsed JavaScript value. Inputs must not be mutated during
// this call; outputs retain no mutable input or decoder-owned pointers.
func (s *Service) Resolve(configJSON, requestJSON []byte) Resolution {
	if s == nil || s.decoder == nil {
		return Resolution{Status: Unavailable}
	}
	if len(configJSON) > MaxPolicyBytes {
		return Resolution{Status: ConfigInvalid}
	}
	p, err := s.decoder.DecodePolicy(append([]byte(nil), configJSON...))
	if err != nil {
		return Resolution{Status: ConfigInvalid}
	}
	if p == nil {
		return Resolution{Status: ConfigMissing}
	}
	if !validPolicy(*p) {
		return Resolution{Status: ConfigInvalid}
	}
	if len(requestJSON) > MaxSelectionBytes {
		return Resolution{Status: SelectionInvalid}
	}
	r, err := s.decoder.DecodeSelection(append([]byte(nil), requestJSON...))
	if err != nil || !optional(r.Harness, taskName) || !optional(r.Model, taskName) || !optional(r.Effort, effortName) {
		return Resolution{Status: SelectionInvalid}
	}
	harness := fallback(r.Harness, p.DefaultHarness)
	h, ok := p.Harnesses[harness]
	if !ok {
		return Resolution{Status: HarnessMissing}
	}
	supported := false
	for _, name := range s.supported {
		supported = supported || name == harness
	}
	if !supported {
		return Resolution{Status: HarnessUnsupported}
	}
	alias := fallback(r.Model, h.DefaultModel)
	m, ok := h.Models[alias]
	if !ok {
		return Resolution{Status: ModelMissing}
	}
	if s.digester == nil {
		return Resolution{Status: Unavailable}
	}
	identity, err := canonicalPolicy(*p)
	if err != nil {
		return Resolution{Status: Unavailable}
	}
	digest, err := s.digester.Digest(identity)
	if err != nil || !validDigest(digest) {
		return Resolution{Status: Unavailable}
	}
	effort := r.Effort
	if effort == nil {
		effort = m.DefaultEffort
	}
	selection := &Selection{Harness: strings.Clone(harness), ModelAlias: strings.Clone(alias), Model: strings.Clone(m.Model)}
	if effort != nil {
		value := strings.Clone(*effort)
		selection.Effort = &value
	}
	return Resolution{Status: Ready, Selection: selection, ConfigSHA256: strings.Clone(digest)}
}

func validPolicy(p port.TaskModelPolicy) bool {
	if !taskName(p.DefaultHarness) || len(p.Harnesses) < 1 || len(p.Harnesses) > 16 {
		return false
	}
	if _, ok := p.Harnesses[p.DefaultHarness]; !ok {
		return false
	}
	for name, h := range p.Harnesses {
		if !taskName(name) || !taskName(h.DefaultModel) || len(h.Models) < 1 || len(h.Models) > 64 {
			return false
		}
		if _, ok := h.Models[h.DefaultModel]; !ok {
			return false
		}
		for alias, m := range h.Models {
			if !taskName(alias) || !runtimeModel(m.Model) || !optional(m.DefaultEffort, effortName) {
				return false
			}
		}
	}
	return true
}

// Restricted ASCII strings make these array bytes identical to JSON.stringify.
// Missing defaultEffort is null; harness names and aliases are sorted.
func canonicalPolicy(p port.TaskModelPolicy) ([]byte, error) {
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

func optional(v *string, valid func(string) bool) bool { return v == nil || valid(*v) }
func fallback(v *string, otherwise string) string {
	if v != nil {
		return *v
	}
	return otherwise
}
func lowerDigit(c byte) bool { return c >= 'a' && c <= 'z' || c >= '0' && c <= '9' }
func taskName(s string) bool {
	if len(s) < 1 || len(s) > 80 || s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for i := 1; i < len(s); i++ {
		if lowerDigit(s[i]) {
			continue
		}
		if (s[i] != '-' && s[i] != '_' && s[i] != '.') || i+1 == len(s) || !lowerDigit(s[i+1]) {
			return false
		}
	}
	return true
}
func effortName(s string) bool {
	if len(s) < 1 || len(s) > 40 {
		return false
	}
	for i := range len(s) {
		c := s[i]
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
	for i := range len(s) {
		c := s[i]
		if !lowerDigit(c) && !(c >= 'A' && c <= 'Z') && c != '_' && c != '-' && c != '.' && c != '/' {
			return false
		}
	}
	return true
}
func validDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := range len(s) {
		if !(s[i] >= 'a' && s[i] <= 'f') && !(s[i] >= '0' && s[i] <= '9') {
			return false
		}
	}
	return true
}
