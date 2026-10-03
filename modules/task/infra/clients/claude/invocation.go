// Package claude owns selected print-mode arguments and provider observation.
// This source slice executes nothing and advertises no installed capabilities.
package claude

import (
	"regexp"
	"strings"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type EffortMapping struct{ Requested, Argument string }

// Selection is one already-resolved invocation, not a settings/model registry.
// Mapping/capability declarations require separate selected-route qualification.
type Selection struct {
	Binding                                          task.Binding
	Scope                                            task.AdmissionBinding
	RuntimeID, AdmissionID, SessionID, ReportedModel string
	Efforts                                          []EffortMapping
	ExactResume                                      bool
}
type Selected struct {
	binding                                            task.Binding
	scope                                              task.AdmissionBinding
	runtime, admission, session, reportedModel, effort string
	resume                                             bool
}
type RequestedModel struct{ Provider, Alias, Effort string }
type ResolvedModel struct{ RuntimeID, ProfileID, Model, EffortArgument, ConfigDigest string }
type ModelFacts struct {
	Requested RequestedModel
	Resolved  ResolvedModel
	// Correlation is not current authorization, provider acceptance or observation.
	AdmissionCorrelation, AdmissionEvidence string
}
type Invocation struct {
	operation string
	selected  *Selected
	arguments []string
	input     []byte
}

var sessionShape = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func NewSelection(s Selection) (*Selected, error) {
	if !s.Binding.Valid() || s.Binding.Provider != task.Claude || !s.Scope.Valid() || !task.ID(s.RuntimeID) || !task.ID(s.AdmissionID) || !sessionShape.MatchString(s.SessionID) || !task.ID(s.ReportedModel) || len(s.Efforts) > 32 {
		return nil, task.ErrInvalid
	}
	seen := map[string]bool{}
	argument := ""
	for _, m := range s.Efforts {
		if !task.ID(m.Requested) || seen[m.Requested] {
			return nil, task.ErrInvalid
		}
		switch m.Argument {
		case "low", "medium", "high", "max":
		default:
			return nil, task.ErrUnsupported
		}
		seen[m.Requested] = true
		if m.Requested == s.Binding.Effort {
			argument = m.Argument
		}
	}
	if s.Binding.Effort != "" && argument == "" {
		return nil, task.ErrUnsupported
	}
	return &Selected{binding: s.Binding, scope: s.Scope, runtime: s.RuntimeID, admission: s.AdmissionID, session: s.SessionID, reportedModel: s.ReportedModel, effort: argument, resume: s.ExactResume}, nil
}
func (s *Selected) Binding() task.Binding {
	if s == nil {
		return task.Binding{}
	}
	return s.binding
}
func (s *Selected) Build(d port.Dispatch) (*Invocation, error) {
	if s == nil {
		return nil, task.ErrUnavailable
	}
	i := d.Intent
	if i.Binding != s.binding || i.Admission != s.scope || i.TaskID != s.scope.TaskID {
		return nil, task.ErrIdentity
	}
	if !task.ID(i.OperationID) || !task.ID(i.Digest) || !i.Parent.Valid() || !task.Text(d.Message, 32768) || strings.TrimSpace(d.Message) == "" {
		return nil, task.ErrInvalid
	}
	sessionFlag := "--session-id"
	switch i.Action {
	case task.Create:
		if i.Expected != (task.Reference{}) {
			return nil, task.ErrIdentity
		}
	case task.Resume:
		if !s.resume {
			return nil, task.ErrUnsupported
		}
		if !i.Expected.Complete(task.Claude) || i.Expected.SessionID != s.session || i.Expected.InvocationID == i.OperationID {
			return nil, task.ErrIdentity
		}
		sessionFlag = "--resume"
	default:
		return nil, task.ErrUnsupported
	}
	args := []string{"--print", "--output-format", "stream-json", "--verbose", sessionFlag, s.session, "--model", s.binding.Model, "--permission-mode", "default", "--permission-prompts", "none"}
	if s.binding.Effort != "" {
		args = append(args, "--effort", s.effort)
	}
	return &Invocation{operation: i.OperationID, selected: s, arguments: args, input: []byte(d.Message + "\n")}, nil
}

// Accessors copy private transient bytes. No shell string or environment is built.
func (i *Invocation) Arguments() []string {
	if i == nil {
		return nil
	}
	return append([]string(nil), i.arguments...)
}
func (i *Invocation) Input() []byte {
	if i == nil {
		return nil
	}
	return append([]byte(nil), i.input...)
}
func (i *Invocation) OperationID() string {
	if i == nil {
		return ""
	}
	return i.operation
}
func (i *Invocation) SessionID() string {
	if i == nil {
		return ""
	}
	return i.selected.session
}
func (i *Invocation) Models() ModelFacts {
	if i == nil {
		return ModelFacts{}
	}
	s := i.selected
	b := s.binding
	return ModelFacts{Requested: RequestedModel{string(b.Provider), b.ModelAlias, b.Effort}, Resolved: ResolvedModel{s.runtime, b.ProfileID, b.Model, s.effort, b.ConfigDigest}, AdmissionCorrelation: s.admission, AdmissionEvidence: "not_observed"}
}
func (i *Invocation) Expected() Expected {
	if i == nil {
		return Expected{}
	}
	return Expected{SessionID: i.selected.session, Cwd: i.selected.binding.Writer.Path, Model: i.selected.reportedModel, PermissionMode: "default"}
}
