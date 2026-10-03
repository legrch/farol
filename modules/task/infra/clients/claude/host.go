package claude

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
	processpeer "github.com/legrch/farol/modules/task/infra/peer/process"
)

// HostOptions is trusted per-invocation Root composition, not a wire grant.
// Recheck must qualify the selected native/CLI capabilities, effective cohort
// ownership and current authority. A Task physical-root check alone is insufficient.
type HostOptions struct {
	Selection   Selection
	OperationID string
	Process     *processpeer.Client
	Recheck     func(context.Context, Selection) (task.Capabilities, error)
	Now         func() uint64
	// Output carries opt-in useful text transiently, never into metadata/journal.
	Output func(context.Context, task.Reference, string) error
}

// Host owns only one selected operation, local one-shot fences and its parser.
// Task/Computer own durable intent, admission, owning handle and retirement.
type Host struct {
	mu                       sync.Mutex
	selected                 *Selected
	selection                Selection
	operation                string
	process                  port.ClaudeProcess
	recheck                  func(context.Context, Selection) (task.Capabilities, error)
	now                      func() uint64
	output                   func(context.Context, task.Reference, string) error
	attempted                bool
	digest                   [32]byte
	receipt                  task.Receipt
	failure                  error
	blocked                  bool
	handle                   string
	reference                task.Reference
	stream                   *Stream
	stdout, stderr           uint64
	stdoutBytes, stderrBytes uint64
	events                   func(context.Context, task.ExecutionEvent) error
	streamID                 string
	sequence                 uint64
	terminalEvent            bool
	startupPause             func(context.Context) error
}

var _ port.ClaudeHost = (*Host)(nil)
var _ port.Provider = (*Host)(nil)
var _ port.ObservedProvider = (*Host)(nil)

// NewHost is lazy and accepts only the actual published Computer peer. It
// neither calls the qualification gate nor issues a process/admission effect.
func NewHost(o HostOptions) (*Host, error) {
	if o.Process == nil {
		return nil, task.ErrUnavailable
	}
	p := o.Process.Selection()
	if p != (processpeer.Selection{OperationID: o.OperationID, RuntimeID: o.Selection.RuntimeID, SessionID: o.Selection.SessionID, ModelID: o.Selection.Binding.Model, AdmissionID: o.Selection.AdmissionID}) {
		return nil, task.ErrIdentity
	}
	return newHost(o, o.Process)
}

// Private CPU aggregate seam; production never accepts a scripted process port.
func newHost(o HostOptions, p port.ClaudeProcess) (*Host, error) {
	if p == nil || o.Recheck == nil {
		return nil, task.ErrUnavailable
	}
	if !task.ID(o.OperationID) || o.Now == nil {
		return nil, task.ErrInvalid
	}
	s, err := NewSelection(o.Selection)
	if err != nil {
		return nil, err
	}
	selection := o.Selection
	selection.Efforts = append([]EffortMapping(nil), selection.Efforts...)
	identity, _ := json.Marshal(struct{ Runtime, Session, Operation string }{s.runtime, s.session, o.OperationID})
	hash := sha256.Sum256(identity)
	return &Host{selected: s, selection: selection, operation: o.OperationID, process: p, recheck: o.Recheck, now: o.Now, output: o.Output, streamID: hex.EncodeToString(hash[:])}, nil
}

func hostCall[T any](f func() (T, error)) (v T, err error) {
	defer func() {
		if recover() != nil {
			var zero T
			v, err = zero, task.ErrUnknown
		}
	}()
	return f()
}
func hostPublish(f func() error) error {
	_, err := hostCall(func() (struct{}, error) { return struct{}{}, f() })
	return err
}
func (h *Host) current(ctx context.Context, b task.Binding) (task.Capabilities, error) {
	if ctx == nil || ctx.Err() != nil {
		return task.Capabilities{}, task.ErrUnavailable
	}
	if b != h.selected.binding {
		return task.Capabilities{}, task.ErrIdentity
	}
	s := h.selection
	s.Efforts = append([]EffortMapping(nil), s.Efforts...)
	caps, err := hostCall(func() (task.Capabilities, error) { return h.recheck(ctx, s) })
	if err != nil {
		return task.Capabilities{}, err
	}
	if ctx.Err() != nil {
		return task.Capabilities{}, task.ErrUnavailable
	}
	// This slice has no active input or qualified signal controller. Do not
	// turn a broad host declaration into those capabilities.
	if !caps.Create && !(caps.Resume && h.selected.resume) {
		return task.Capabilities{}, task.ErrUnavailable
	}
	return task.Capabilities{Create: caps.Create, Resume: caps.Resume && h.selected.resume}, nil
}
func (h *Host) Supports(ctx context.Context, b task.Binding) (task.Capabilities, error) {
	if h == nil {
		return task.Capabilities{}, task.ErrUnavailable
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.blocked {
		return task.Capabilities{}, task.ErrUnknown
	}
	return h.current(ctx, b)
}
func hostRefused(code string) task.Receipt { return task.Receipt{State: task.Rejected, Code: code} }
func (h *Host) unknown() (task.Receipt, error) {
	h.blocked = true
	h.receipt, h.failure = task.Receipt{State: task.Uncertain}, task.ErrUnknown
	return h.receipt, h.failure
}
func (h *Host) Create(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	if d.Intent.Action != task.Create {
		return hostRefused("CLAUDE_TASK_INVALID"), nil
	}
	return h.Dispatch(ctx, d, progress)
}
func (h *Host) Resume(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	if d.Intent.Action != task.Resume {
		return hostRefused("CLAUDE_TASK_INVALID"), nil
	}
	return h.Dispatch(ctx, d, progress)
}
func (h *Host) Cancel(context.Context, port.Dispatch, func(task.Reference) error) (task.Receipt, error) {
	return hostRefused("CLAUDE_TASK_CAPABILITY_UNAVAILABLE"), nil
}
func (h *Host) Dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	return h.dispatch(ctx, d, progress, nil)
}
func (h *Host) DispatchObserved(ctx context.Context, d port.Dispatch, progress func(task.Reference) error, record func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
	if record == nil {
		return hostRefused("CLAUDE_TASK_INVALID"), nil
	}
	return h.dispatch(ctx, d, progress, record)
}
func (h *Host) dispatch(ctx context.Context, d port.Dispatch, progress func(task.Reference) error, record func(context.Context, task.ExecutionEvent) error) (task.Receipt, error) {
	if h == nil {
		return hostRefused("CLAUDE_TASK_UNAVAILABLE"), nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if progress == nil || d.Intent.OperationID != h.operation {
		return hostRefused("CLAUDE_TASK_IDENTITY_MISMATCH"), nil
	}
	inv, err := h.selected.Build(d)
	if err != nil {
		return hostRefused("CLAUDE_TASK_SELECTION_REFUSED"), nil
	}
	encoded, _ := json.Marshal(d)
	digest := sha256.Sum256(encoded)
	if h.attempted {
		if digest != h.digest {
			return hostRefused("CLAUDE_TASK_OPERATION_CONFLICT"), nil
		}
		if h.receipt.State == task.Known {
			if _, err := h.current(ctx, h.selected.binding); err != nil {
				return h.unknown()
			}
		}
		return h.receipt, h.failure // local receipt only; no process/callback replay
	}
	h.attempted, h.digest = true, digest
	h.receipt = hostRefused("CLAUDE_TASK_UNAVAILABLE")
	caps, err := h.current(ctx, d.Intent.Binding)
	if err != nil || !caps.Supports(d.Intent.Action) {
		return h.receipt, nil
	}
	stream, err := NewStream(inv.Expected())
	if err != nil {
		return h.receipt, nil
	}
	h.stream, h.events = stream, record
	q := port.ClaudeInvocation{OperationID: h.operation, RuntimeID: h.selected.runtime, SessionID: h.selected.session, ModelID: h.selected.binding.Model, AdmissionID: h.selected.admission, Arguments: inv.Arguments(), Input: inv.Input()}
	prepared, err := hostCall(func() (port.ClaudePreparation, error) { return h.process.Prepare(ctx, q) })
	if err != nil {
		var classified *port.ClaudeProcessFailure
		if errors.As(err, &classified) && classified != nil && classified.Outcome == "refused" && classified.Retry == "never" {
			h.receipt = hostRefused("CLAUDE_TASK_PROCESS_REFUSED")
			return h.receipt, nil
		}
		return h.unknown()
	}
	if prepared.OperationID != q.OperationID || prepared.RuntimeID != q.RuntimeID || prepared.SessionID != q.SessionID || prepared.ModelID != q.ModelID || prepared.AdmissionID != q.AdmissionID || !hostDigest(prepared.Digest) {
		return h.unknown()
	}
	// Recheck after preparation, directly before the ONE selected start. The
	// owning Computer repeats its real lease/native checks at the effect itself.
	caps, err = h.current(ctx, d.Intent.Binding)
	if err != nil || !caps.Supports(d.Intent.Action) {
		return h.receipt, nil
	}
	handle, err := hostCall(func() (string, error) { return h.process.Start(ctx, h.operation) })
	if err != nil {
		var classified *port.ClaudeProcessFailure
		if errors.As(err, &classified) && classified != nil && classified.Outcome == "refused" && classified.Retry == "never" {
			h.receipt = hostRefused("CLAUDE_TASK_PROCESS_REFUSED")
			return h.receipt, nil
		}
		return h.unknown()
	}
	if !task.ID(handle) {
		return h.unknown()
	}
	h.handle = handle
	return h.startup(ctx, progress)
}

// Startup is synchronous observation of ONE already known-start handle. It
// cannot renew the original Computer lease or recover an unknown/refused read.
func (h *Host) startup(parent context.Context, progress func(task.Reference) error) (task.Receipt, error) {
	ctx, cancel := context.WithTimeout(parent, 2*time.Second)
	defer cancel()
	for n := 0; n < 128; n++ {
		if ctx.Err() != nil {
			return h.unknown()
		}
		before := h.stdout + h.stderr
		if err := h.read(ctx, progress); err != nil {
			return h.unknown()
		}
		if h.reference.Complete(task.Claude) {
			return h.receipt, nil
		}
		if h.stdout+h.stderr == before {
			pause := h.startupPause
			if pause == nil {
				pause = hostStartupPause
			}
			if err := hostPublish(func() error { return pause(ctx) }); err != nil {
				return h.unknown()
			}
		}
	}
	return h.unknown()
}
func hostStartupPause(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil {
		return task.ErrUnavailable
	}
	timer := time.NewTimer(25 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return ctx.Err()
	}
}

func hostDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f') {
			return false
		}
	}
	return true
}
