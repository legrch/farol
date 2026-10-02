package task

import (
	"errors"
	"strings"
	"unicode/utf8"
)

type Provider string

const (
	Codex  Provider = "codex"
	Claude Provider = "claude"
)

type Action string

const (
	Create   Action = "create"
	Continue Action = "continue"
	Resume   Action = "resume"
	Message  Action = "message"
	Cancel   Action = "cancel"
	Deliver  Action = "deliver"
)

type Lifecycle string

const (
	Unknown     Lifecycle = "outcome_unknown"
	Running     Lifecycle = "running"
	Completed   Lifecycle = "completed"
	Failed      Lifecycle = "failed"
	Interrupted Lifecycle = "interrupted"
	NeedsInput  Lifecycle = "needs_input"
	Refused     Lifecycle = "refused"
)

func (l Lifecycle) Terminal() bool {
	return l == Completed || l == Failed || l == Interrupted || l == NeedsInput
}
func (l Lifecycle) Valid() bool { return l == Unknown || l == Running || l == Refused || l.Terminal() }

// Physical identities are measured by the authority adapter, never inferred here.
type Root struct{ Path, Device, Inode, GitCommonDirectory string }
type Binding struct {
	Provider                                  Provider
	ProfileID, HostID, ProjectID, WorkspaceID string
	Project, Writer                           Root
	ModelAlias, Model, Effort, ConfigDigest   string
}
type Parent struct{ ThreadID, TurnID string }

func (p Parent) Valid() bool {
	return (p.ThreadID == "" && p.TurnID == "") || (ID(p.ThreadID) && ID(p.TurnID))
}
func (b Binding) Valid() bool {
	return (b.Provider == Codex || b.Provider == Claude) && ID(b.ProfileID) && ID(b.HostID) && ID(b.ProjectID) && ID(b.WorkspaceID) &&
		root(b.Project) && root(b.Writer) && b.Project.GitCommonDirectory == b.Writer.GitCommonDirectory &&
		ID(b.ModelAlias) && ID(b.Model) && (b.Effort == "" || ID(b.Effort)) && ID(b.ConfigDigest)
}
func root(r Root) bool {
	return Text(r.Path, 4096) && Text(r.Device, 64) && Text(r.Inode, 64) && Text(r.GitCommonDirectory, 4096)
}
func ID(s string) bool { return Text(s, 128) && !strings.ContainsAny(s, "\r\n\t") }
func Text(s string, limit int) bool {
	return s != "" && len(s) <= limit && utf8.ValidString(s) && !strings.ContainsRune(s, 0)
}

// InvocationID is Farol-owned Claude process identity, not a provider turn ID.
type Reference struct{ SessionID, ThreadID, TurnID, InvocationID string }

func (r Reference) Complete(p Provider) bool {
	if p == Codex {
		return r.SessionID == "" && r.InvocationID == "" && ID(r.ThreadID) && ID(r.TurnID)
	}
	return p == Claude && ID(r.SessionID) && r.ThreadID == "" && r.TurnID == "" && ID(r.InvocationID)
}
func (r Reference) SameSession(other Reference, p Provider) bool {
	if p == Codex {
		return r.ThreadID != "" && r.ThreadID == other.ThreadID && r.SessionID == "" && other.SessionID == ""
	}
	return p == Claude && r.SessionID != "" && r.SessionID == other.SessionID && r.ThreadID == "" && other.ThreadID == ""
}

// Progress binds only matching prefixes. It is not terminal proof.
func (r Reference) Extend(next Reference, p Provider) bool {
	if p == Codex && (next.SessionID != "" || next.InvocationID != "" || next.ThreadID == "" || !ID(next.ThreadID) || (next.TurnID != "" && !ID(next.TurnID))) {
		return false
	}
	if p == Claude && (next.ThreadID != "" || next.TurnID != "" || !ID(next.SessionID) || (next.InvocationID != "" && !ID(next.InvocationID))) {
		return false
	}
	return (r.SessionID == "" || r.SessionID == next.SessionID) && (r.ThreadID == "" || r.ThreadID == next.ThreadID) && (r.TurnID == "" || r.TurnID == next.TurnID) && (r.InvocationID == "" || r.InvocationID == next.InvocationID)
}

type Capabilities struct{ Create, Continue, Resume, Message, Cancel bool }

func (c Capabilities) Supports(a Action) bool {
	switch a {
	case Create:
		return c.Create
	case Continue:
		return c.Continue
	case Resume:
		return c.Resume
	case Message:
		return c.Message
	case Cancel:
		return c.Cancel
	}
	return false
}

type Task struct {
	ID        string
	Binding   Binding
	Parent    Parent
	Reference Reference
	Lifecycle Lifecycle
	Result    string
	// Result belongs to one dispatch, even while a later follow-up is admitted.
	DispatchID         string
	CancelRequested    bool
	DeliveryDispatchID string
}

func (t Task) Allows(a Action, c Capabilities) bool {
	if !c.Supports(a) || !t.Reference.Complete(t.Binding.Provider) {
		return false
	}
	switch a {
	case Continue:
		return t.Binding.Provider == Codex && (t.Lifecycle == Completed || t.Lifecycle == Failed || t.Lifecycle == Interrupted)
	case Resume:
		return t.Binding.Provider == Claude && (t.Lifecycle == Completed || t.Lifecycle == Failed || t.Lifecycle == Interrupted)
	case Message, Cancel:
		return t.Lifecycle == Running && !t.CancelRequested
	}
	return false
}

type Intent struct {
	OperationID, TaskID, Digest string
	Action                      Action
	Binding                     Binding
	Parent                      Parent
	Expected                    Reference
}
type ReceiptState string

const (
	Known     ReceiptState = "known"
	Uncertain ReceiptState = "outcome_unknown"
	Rejected  ReceiptState = "refused"
)

type Receipt struct {
	State           ReceiptState
	Code            string
	Reference       Reference
	Lifecycle       Lifecycle
	Result          string
	CancelRequested bool
}

var ErrInvalid = errors.New("TASK_INVALID")
var ErrConflict = errors.New("TASK_OPERATION_CONFLICT")
var ErrUnavailable = errors.New("TASK_UNAVAILABLE")
var ErrUnsupported = errors.New("TASK_CAPABILITY_UNAVAILABLE")
var ErrUnknown = errors.New("TASK_OUTCOME_UNKNOWN")
var ErrNotFound = errors.New("TASK_NOT_FOUND")
var ErrState = errors.New("TASK_STATE_REFUSED")
var ErrIdentity = errors.New("TASK_IDENTITY_MISMATCH")
