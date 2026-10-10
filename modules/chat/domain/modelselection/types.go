// Package modelselection owns account-scoped catalogue policy. It has no host effects.
package modelselection

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

type Backend string
type Billing string

const (
	PlanInference Backend = "plan-inference"
	CodexTask     Backend = "codex-task"
	BrowserChat   Backend = "browser-chat"
	Plan          Billing = "chatgpt-plan"
	API           Billing = "api"
)

type Route struct {
	Provider string
	Backend  Backend
	Billing  Billing
}
type Scope struct {
	Route     Route
	AccountID string
}
type Source string

const (
	SIWC      Source = "siwc-models"
	AppServer Source = "app-server-model-list"
	Browser   Source = "browser-profile"
)

type Knowledge string

const (
	Unknown Knowledge = "unknown"
	Yes     Knowledge = "yes"
	No      Knowledge = "no"
)

// Provenance must identify product evidence supplied independently of a catalogue.
// A catalogue never proves capability support or live entitlement.
type Capabilities struct {
	Text, Image, Tools   Knowledge
	Revision, Provenance string
}
type Entry struct {
	Slug, DisplayName string
	Hidden, Archived  bool
	Efforts           []string
	DefaultEffort     string
	Capabilities      Capabilities
}
type Snapshot struct {
	Scope                             Scope
	Epoch                             uint64
	Revision                          string
	ObservedAtMillis, ExpiresAtMillis uint64
	Source                            Source
	Complete                          bool
	Entries                           []Entry
}

type ErrorCode string

const (
	Invalid        ErrorCode = "invalid-catalogue"
	WrongScope     ErrorCode = "account-or-route-changed"
	Stale          ErrorCode = "catalogue-expired"
	Partial        ErrorCode = "catalogue-incomplete"
	Unavailable    ErrorCode = "model-unavailable"
	Unsupported    ErrorCode = "requirements-unsupported"
	Changed        ErrorCode = "binding-changed"
	BudgetUnknown  ErrorCode = "budget-unknown"
	BudgetExceeded ErrorCode = "budget-exceeded"
)

type PolicyError struct {
	Code   ErrorCode
	Detail string
}

func (e *PolicyError) Error() string           { return string(e.Code) + ": " + e.Detail }
func deny(code ErrorCode, detail string) error { return &PolicyError{code, detail} }

func validString(s string, max int) bool {
	return len(s) > 0 && len(s) <= max && utf8.ValidString(s) && strings.TrimSpace(s) == s && !strings.ContainsFunc(s, unicode.IsControl)
}

func ValidateScope(s Scope) error {
	if !validString(s.AccountID, 256) {
		return deny(Invalid, "invalid account scope")
	}
	r := s.Route
	if (r.Provider == "openai" && r.Backend == PlanInference && r.Billing == Plan) ||
		(r.Provider == "codex" && r.Backend == CodexTask && (r.Billing == Plan || r.Billing == API)) ||
		(r.Provider == "farol" && r.Backend == BrowserChat && r.Billing == Plan) {
		return nil
	}
	return deny(Invalid, "unsupported provider/backend/billing combination")
}

func ValidateSnapshot(s Snapshot) error {
	if err := ValidateScope(s.Scope); err != nil {
		return err
	}
	if s.Epoch == 0 || !validString(s.Revision, 256) || s.ExpiresAtMillis <= s.ObservedAtMillis {
		return deny(Invalid, "invalid epoch, revision or expiry")
	}
	if (s.Source == SIWC && s.Scope.Route.Backend != PlanInference) ||
		(s.Source == AppServer && s.Scope.Route.Backend != CodexTask) ||
		(s.Source == Browser && s.Scope.Route.Backend != BrowserChat) ||
		(s.Source != SIWC && s.Source != AppServer && s.Source != Browser) {
		return deny(Invalid, "catalogue source does not match backend")
	}
	if len(s.Entries) > 2048 {
		return deny(Invalid, "catalogue entry limit exceeded")
	}
	seen := make(map[string]bool, len(s.Entries))
	for _, e := range s.Entries {
		if !validString(e.Slug, 256) || !validString(e.DisplayName, 512) || seen[e.Slug] {
			return deny(Invalid, "invalid or duplicate model slug")
		}
		seen[e.Slug] = true
		if len(e.Efforts) > 32 {
			return deny(Invalid, "effort limit exceeded")
		}
		efforts := map[string]bool{}
		for _, v := range e.Efforts {
			if !validString(v, 64) || efforts[v] {
				return deny(Invalid, "invalid or duplicate effort")
			}
			efforts[v] = true
		}
		if e.DefaultEffort != "" && !efforts[e.DefaultEffort] {
			return deny(Invalid, "default effort is not advertised")
		}
		c := e.Capabilities
		known := false
		for _, v := range []Knowledge{c.Text, c.Image, c.Tools} {
			if v != Unknown && v != Yes && v != No {
				return deny(Invalid, "invalid capability knowledge")
			}
			known = known || v != Unknown
		}
		if known && (!validString(c.Revision, 256) || !validString(c.Provenance, 256) || c.Provenance == string(SIWC) || c.Provenance == string(AppServer) || c.Provenance == string(Browser)) {
			return deny(Invalid, "capabilities require independent product evidence")
		}
		if c.Revision != "" && !validString(c.Revision, 256) {
			return deny(Invalid, "invalid capability revision")
		}
		if c.Provenance != "" && !validString(c.Provenance, 256) {
			return deny(Invalid, "invalid capability provenance")
		}
	}
	return nil
}

// CloneSnapshot prevents caller-owned effort slices from sharing mutable state.
func CloneSnapshot(s Snapshot) Snapshot {
	s.Entries = append([]Entry(nil), s.Entries...)
	for i := range s.Entries {
		s.Entries[i].Efforts = append([]string(nil), s.Entries[i].Efforts...)
	}
	return s
}

func describeRequirements(r Requirements) string {
	return fmt.Sprintf("text=%t image=%t tools=%t", r.Text, r.Image, r.Tools)
}
