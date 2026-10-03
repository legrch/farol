package process

import (
	"context"

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
	return New(command, p.qualification, p.clock)
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
