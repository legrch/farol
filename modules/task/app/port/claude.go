package port

import (
	"context"
	"github.com/legrch/farol/modules/task/domain"
)

// ClaudeInvocation is transient input to ONE selected Computer operation. It
// cannot choose executable/env/root/lease/deadline or grant current authority.
type ClaudeInvocation struct {
	OperationID, RuntimeID, SessionID, ModelID, AdmissionID string
	Arguments                                               []string
	Input                                                   []byte
}
type ClaudePreparation struct{ OperationID, RuntimeID, SessionID, ModelID, AdmissionID, Digest string }
type ClaudeRead struct {
	Handle                     string
	StdoutOffset, StderrOffset uint64
}
type ClaudeObservation struct {
	Handle, State, RootState, GroupCleanup, DescendantCleanup                               string
	RootWaited, OutputDrained, OutputLimitReached, CancelRequested, TimedOut, AuthorityLost bool
	ExitCode                                                                                *int
	ExitSignal                                                                              int
	Stdout, Stderr                                                                          []byte
	StdoutNext, StderrNext, StdoutBytes, StderrBytes                                        uint64
}
type ClaudeCancellation struct{ Status string }

// Prepare echo is correlation only. Provider identity must come from actual
// structured output; terminal also requires the SAME child/cohort evidence.
type ClaudeProcess interface {
	Prepare(context.Context, ClaudeInvocation) (ClaudePreparation, error)
	Start(context.Context, string) (string, error)
	Read(context.Context, ClaudeRead) (ClaudeObservation, error)
	Cancel(context.Context, string) (ClaudeCancellation, error)
}

// Classified selected-process failure; no provider payload enters diagnostics.
type ClaudeProcessFailure struct{ Code, Outcome, Retry string }

func (e *ClaudeProcessFailure) Error() string { return e.Code }

func (e *ClaudeProcessFailure) Unwrap() error {
	if e.Outcome == "outcome_unknown" {
		return task.ErrUnknown
	}
	return task.ErrState
}
