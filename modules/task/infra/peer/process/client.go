// Package process adapts the selected published Computer contract for Claude.
// The existing Task/Computer journals own durability. This per-operation local
// fence is additional protection, never an executor, admission or restart owner.
package process

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"

	computer "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type Selection struct{ OperationID, RuntimeID, SessionID, ModelID, AdmissionID string }
type contractPort interface {
	Prepare(context.Context, computer.PrepareRequest) (*computer.PrepareResponse, error)
	Start(context.Context, computer.StartRequest) (*computer.StartResponse, error)
	Read(context.Context, computer.ReadRequest) (*computer.ReadResponse, error)
	Cancel(context.Context, computer.CancelRequest) (*computer.CancelResponse, error)
}
type Client struct {
	mu                                    sync.Mutex
	contract                              contractPort
	selected                              Selection
	prepareUsed, startUsed, cancelUsed    bool
	requestDigest                         [32]byte
	prepared                              port.ClaudePreparation
	handle                                string
	prepareError, startError, cancelError error
	cancellation                          port.ClaudeCancellation
}

var _ port.ClaudeProcess = (*Client)(nil)

// Production composition accepts the real published contract, not a provider
// factory, caller-selected transport, private Computer service or alternate CLI.
func New(c *computer.Contract, s Selection) (*Client, error) {
	if c == nil {
		return nil, task.ErrUnavailable
	}
	if !task.ID(s.OperationID) || !task.ID(s.RuntimeID) || !task.ID(s.SessionID) || !task.ID(s.ModelID) || !task.ID(s.AdmissionID) {
		return nil, task.ErrInvalid
	}
	return &Client{contract: c, selected: s}, nil
}
func usable(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil {
		return task.ErrUnavailable
	}
	return nil
}
func failure(err error) error {
	var classified *computer.Failure
	if errors.As(err, &classified) && classified != nil && classified.Retry == "never" && code(classified.Code) && (classified.Outcome == "refused" || classified.Outcome == "outcome_unknown") {
		return &port.ClaudeProcessFailure{Code: classified.Code, Outcome: classified.Outcome, Retry: "never"}
	}
	return unknown()
}
func unknown() error {
	return &port.ClaudeProcessFailure{Code: "CLAUDE_PROCESS_OUTCOME_UNKNOWN", Outcome: "outcome_unknown", Retry: "never"}
}
func code(s string) bool {
	if len(s) == 0 || len(s) > 128 {
		return false
	}
	for _, r := range s {
		if !(r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return true
}
func digest(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	if err != nil {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
func (c *Client) Prepare(ctx context.Context, q port.ClaudeInvocation) (port.ClaudePreparation, error) {
	if c == nil {
		return port.ClaudePreparation{}, task.ErrUnavailable
	}
	if err := usable(ctx); err != nil {
		return port.ClaudePreparation{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.selected
	if q.OperationID != s.OperationID || q.RuntimeID != s.RuntimeID || q.SessionID != s.SessionID || q.ModelID != s.ModelID || q.AdmissionID != s.AdmissionID {
		return port.ClaudePreparation{}, task.ErrIdentity
	}
	if len(q.Arguments) > 256 || len(q.Input) > 1<<20 {
		return port.ClaudePreparation{}, task.ErrInvalid
	}
	n := 0
	for _, arg := range q.Arguments {
		if !task.Text(arg, 65536) {
			return port.ClaudePreparation{}, task.ErrInvalid
		}
		n += len(arg)
	}
	if n > 65536 {
		return port.ClaudePreparation{}, task.ErrInvalid
	}
	// Copy before crossing the contract; input is never retained in local state.
	args := append([]string(nil), q.Arguments...)
	input := append([]byte(nil), q.Input...)
	q.Arguments, q.Input = args, input
	canonical, _ := json.Marshal(q)
	identity := sha256.Sum256(canonical)
	if c.prepareUsed {
		if identity != c.requestDigest {
			return port.ClaudePreparation{}, task.ErrConflict
		}
		return c.prepared, c.prepareError
	}
	c.prepareUsed = true
	c.requestDigest = identity
	r, err := invoke(func() (*computer.PrepareResponse, error) {
		return c.contract.Prepare(ctx, computer.PrepareRequest{OperationID: q.OperationID, Invocation: computer.Invocation{RuntimeID: q.RuntimeID, SessionID: q.SessionID, ModelID: q.ModelID, AdmissionID: q.AdmissionID, Arguments: args, Input: input}})
	})
	if err != nil {
		c.prepareError = failure(err)
	} else if r == nil || r.OperationID != s.OperationID || r.RuntimeID != s.RuntimeID || r.SessionID != s.SessionID || r.ModelID != s.ModelID || r.AdmissionID != s.AdmissionID || !digest(r.Digest) {
		c.prepareError = unknown()
	} else {
		c.prepared = port.ClaudePreparation{OperationID: r.OperationID, RuntimeID: r.RuntimeID, SessionID: r.SessionID, ModelID: r.ModelID, AdmissionID: r.AdmissionID, Digest: r.Digest}
	}
	return c.prepared, c.prepareError
}
func (c *Client) Start(ctx context.Context, op string) (string, error) {
	if c == nil {
		return "", task.ErrUnavailable
	}
	if err := usable(ctx); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if op != c.selected.OperationID {
		return "", task.ErrIdentity
	}
	if !c.prepareUsed {
		return "", task.ErrState
	}
	if c.prepareError != nil {
		return "", c.prepareError
	}
	if c.startUsed {
		return c.handle, c.startError
	}
	c.startUsed = true
	r, err := invoke(func() (*computer.StartResponse, error) {
		return c.contract.Start(ctx, computer.StartRequest{OperationID: op})
	})
	if err != nil {
		c.startError = failure(err)
	} else if r == nil || r.OperationID != op || !task.ID(r.Handle) {
		c.startError = unknown()
	} else {
		c.handle = r.Handle
	}
	return c.handle, c.startError
}

const outputLimit = 4 << 20

func (c *Client) Read(ctx context.Context, q port.ClaudeRead) (port.ClaudeObservation, error) {
	if c == nil {
		return port.ClaudeObservation{}, task.ErrUnavailable
	}
	if err := usable(ctx); err != nil {
		return port.ClaudeObservation{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.startUsed {
		return port.ClaudeObservation{}, task.ErrState
	}
	if c.startError != nil {
		return port.ClaudeObservation{}, c.startError
	}
	if c.handle == "" {
		return port.ClaudeObservation{}, unknown()
	}
	if q.Handle != c.handle || q.StdoutOffset > outputLimit || q.StderrOffset > outputLimit {
		return port.ClaudeObservation{}, task.ErrIdentity
	}
	r, err := invoke(func() (*computer.ReadResponse, error) {
		return c.contract.Read(ctx, computer.ReadRequest{Handle: q.Handle, StdoutOffset: q.StdoutOffset, StderrOffset: q.StderrOffset})
	})
	if err != nil {
		return port.ClaudeObservation{}, failure(err)
	}
	if r == nil || r.Handle != q.Handle || r.StdoutOffset != q.StdoutOffset || r.StderrOffset != q.StderrOffset || r.StdoutBytes > outputLimit || r.StderrBytes > outputLimit-r.StdoutBytes || len(r.StdoutBase64) > 87384 || len(r.StderrBase64) > 87384 {
		return port.ClaudeObservation{}, unknown()
	}
	stdout, e1 := base64.StdEncoding.Strict().DecodeString(r.StdoutBase64)
	stderr, e2 := base64.StdEncoding.Strict().DecodeString(r.StderrBase64)
	if e1 != nil || e2 != nil || len(stdout) > 65536 || len(stderr) > 65536 || r.StdoutNext != q.StdoutOffset+uint64(len(stdout)) || r.StderrNext != q.StderrOffset+uint64(len(stderr)) || r.StdoutNext > r.StdoutBytes || r.StderrNext > r.StderrBytes {
		return port.ClaudeObservation{}, unknown()
	}
	if r.State != computer.Running && r.State != computer.Terminal && r.State != computer.Unknown || r.RootState != computer.RootRunning && r.RootState != computer.RootExited || !cleanup(r.GroupCleanup) || !cleanup(r.DescendantCleanup) {
		return port.ClaudeObservation{}, unknown()
	}
	if r.State == computer.Terminal && (!r.RootWaited || r.RootState != computer.RootExited || !r.OutputDrained || r.GroupCleanup != computer.CleanupConfirmed || r.DescendantCleanup != computer.CleanupConfirmed) {
		return port.ClaudeObservation{}, unknown()
	}
	if r.ExitSignal < 0 || r.ExitSignal > 64 || r.ExitCode != nil && (!r.RootWaited || r.RootState != computer.RootExited) {
		return port.ClaudeObservation{}, unknown()
	}
	var exit *int
	if r.ExitCode != nil {
		if *r.ExitCode < 0 || *r.ExitCode > 255 {
			return port.ClaudeObservation{}, unknown()
		}
		v := *r.ExitCode
		exit = &v
	}
	return port.ClaudeObservation{Handle: r.Handle, State: string(r.State), RootState: string(r.RootState), GroupCleanup: string(r.GroupCleanup), DescendantCleanup: string(r.DescendantCleanup), RootWaited: r.RootWaited, OutputDrained: r.OutputDrained, OutputLimitReached: r.OutputLimitReached, CancelRequested: r.CancelRequested, TimedOut: r.TimedOut, AuthorityLost: r.AuthorityLost, ExitCode: exit, ExitSignal: r.ExitSignal, Stdout: stdout, Stderr: stderr, StdoutNext: r.StdoutNext, StderrNext: r.StderrNext, StdoutBytes: r.StdoutBytes, StderrBytes: r.StderrBytes}, nil
}
func cleanup(c computer.Cleanup) bool {
	return c == computer.CleanupPending || c == computer.CleanupConfirmed || c == computer.CleanupUnverified
}
func (c *Client) Cancel(ctx context.Context, handle string) (port.ClaudeCancellation, error) {
	if c == nil {
		return port.ClaudeCancellation{}, task.ErrUnavailable
	}
	if err := usable(ctx); err != nil {
		return port.ClaudeCancellation{}, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.startUsed {
		return port.ClaudeCancellation{}, task.ErrState
	}
	if c.startError != nil {
		return port.ClaudeCancellation{}, c.startError
	}
	if c.handle == "" {
		return port.ClaudeCancellation{}, unknown()
	}
	if handle != c.handle {
		return port.ClaudeCancellation{}, task.ErrIdentity
	}
	if c.cancelUsed {
		return c.cancellation, c.cancelError
	}
	c.cancelUsed = true
	r, err := invoke(func() (*computer.CancelResponse, error) {
		return c.contract.Cancel(ctx, computer.CancelRequest{Handle: handle})
	})
	if err != nil {
		c.cancelError = failure(err)
	} else if r == nil || r.Status == computer.CancelUnknown {
		c.cancelError = unknown()
	} else if r.Status != computer.CancelRequested && r.Status != computer.AlreadyTerminal {
		c.cancelError = unknown()
	} else {
		c.cancellation.Status = string(r.Status)
	}
	return c.cancellation, c.cancelError
}

func invoke[T any](call func() (*T, error)) (out *T, err error) {
	defer func() {
		if recover() != nil {
			out = nil
			err = unknown()
		}
	}()
	return call()
}
