package process

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Binding is exact provider correlation, not native permission/entitlement.
// Args/stdin remain in Command and all fields participate in its sealed digest.
type InvocationBinding struct{ RuntimeID, SessionID, ModelID, AdmissionID string }

// Preparer maps selected consumer input to a trusted root-owned runtime. It
// executes nothing. Only Spawn can invoke the required native Qualification.
type Preparer struct {
	runtimeID     string
	template      Command
	qualification Qualification
	clock         port.Clock
	anchor        *parentBoundary
	mutex         sync.Mutex
	selected      *Prepared
}

func NewPreparer(runtimeID string, template Command, qualification Qualification, clock port.Clock) (*Preparer, error) {
	if !bindingID(runtimeID) || qualification == nil || clock == nil || !validCommand(template) || len(template.Args) != 0 || len(template.Input) != 0 || template.Binding != nil {
		return nil, &processsvc.NativeFailure{}
	}
	return &Preparer{runtimeID: runtimeID, template: copyCommand(template), qualification: qualification, clock: clock}, nil
}
func (p *Preparer) Scope() processsvc.Scope {
	return processsvc.Scope{RuntimeID: p.runtimeID, WorkspaceID: p.template.WorkspaceID, Root: p.template.Root, Cwd: p.template.Cwd, RootIdentity: p.template.RootIdentity, Write: p.template.Write}
}
func (p *Preparer) Prepare(ctx context.Context, invocation processsvc.Invocation) (processsvc.Selected, error) {
	if ctx == nil || ctx.Err() != nil || invocation.RuntimeID != p.runtimeID {
		return nil, &processsvc.NativeFailure{}
	}
	invocation = invocation.Clone()
	command := copyCommand(p.template)
	command.Args = append([]string(nil), invocation.Arguments...)
	command.Input = append([]byte(nil), invocation.Input...)
	command.Binding = &InvocationBinding{RuntimeID: invocation.RuntimeID, SessionID: invocation.SessionID, ModelID: invocation.ModelID, AdmissionID: invocation.AdmissionID}
	prepared, err := New(command, p.qualification, p.clock)
	if err != nil {
		return nil, err
	}
	if p.anchor != nil {
		p.mutex.Lock()
		defer p.mutex.Unlock()
		if p.selected != nil {
			b := p.selected.Seal().Digest
			// Existing selected command was policy-bound before its seal.
			sealed, bindErr := p.anchor.policy.bind(command)
			if bindErr != nil {
				return nil, bindErr
			}
			a, digestErr := nativeCommandDigest(sealed)
			if digestErr != nil {
				return nil, &processsvc.NativeFailure{}
			}
			if a != b {
				return nil, &processsvc.NativeFailure{Unknown: true}
			}
			return p.selected, nil
		}
		prepared.boundary = p.anchor
		prepared.execution = p.anchor.execution
		p.selected = prepared
	}
	return prepared, nil
}
func (p *Prepared) Invocation() processsvc.Invocation {
	if p.command.Binding == nil {
		return processsvc.Invocation{}
	}
	v := p.command.Binding
	return processsvc.Invocation{RuntimeID: v.RuntimeID, SessionID: v.SessionID, ModelID: v.ModelID, AdmissionID: v.AdmissionID, Arguments: append([]string(nil), p.command.Args...), Input: append([]byte(nil), p.command.Input...)}
}

var _ processsvc.InvocationPreparer = (*Preparer)(nil)
var _ processsvc.Selected = (*Prepared)(nil)

func bindingID(value string) bool {
	if len(value) < 1 || len(value) > 160 {
		return false
	}
	for _, c := range value {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-') {
			return false
		}
	}
	return true
}

// RetainedHandle is trusted root cleanup correlation only, never output access,
// admission, a public request lookup or permission to reconstruct/reissue Spawn.
func (p *Preparer) RetainedHandle() string {
	p.mutex.Lock()
	selected := p.selected
	p.mutex.Unlock()
	if selected == nil {
		return ""
	}
	selected.mutex.Lock()
	defer selected.mutex.Unlock()
	if selected.retained == nil {
		return ""
	}
	return selected.retained.Handle()
}
