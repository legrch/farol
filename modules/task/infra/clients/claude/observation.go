package claude

import (
	"context"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

func (h *Host) Observe(ctx context.Context, b task.Binding, ref task.Reference) (port.Observation, error) {
	if h == nil {
		return port.Observation{}, task.ErrUnavailable
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if b != h.selected.binding || !ref.Complete(task.Claude) || (ref.SessionID != h.selected.session || ref.InvocationID != h.operation) {
		return port.Observation{}, task.ErrIdentity
	}
	if h.blocked {
		return port.Observation{}, task.ErrUnknown
	}
	if _, err := h.current(ctx, b); err != nil {
		h.unknown()
		return port.Observation{}, task.ErrUnknown
	}
	if ref != h.reference || h.receipt.State != task.Known || h.handle == "" {
		return port.Observation{}, task.ErrUnknown
	}
	if !h.receipt.Lifecycle.Terminal() {
		if err := h.read(ctx, nil); err != nil {
			h.unknown()
			return port.Observation{}, task.ErrUnknown
		}
	}
	if _, err := h.current(ctx, b); err != nil {
		h.unknown()
		return port.Observation{}, task.ErrUnknown
	}
	return port.Observation{Reference: ref, Lifecycle: h.receipt.Lifecycle, Result: h.receipt.Result}, nil
}

func (h *Host) read(ctx context.Context, progress func(task.Reference) error) error {
	if _, err := h.current(ctx, h.selected.binding); err != nil {
		return task.ErrUnknown
	}
	q := port.ClaudeRead{Handle: h.handle, StdoutOffset: h.stdout, StderrOffset: h.stderr}
	r, err := hostCall(func() (port.ClaudeObservation, error) { return h.process.Read(ctx, q) })
	if err != nil || !hostRange(q, r) || r.StdoutBytes < h.stdoutBytes || r.StderrBytes < h.stderrBytes {
		return task.ErrUnknown
	}
	if _, err := h.current(ctx, h.selected.binding); err != nil {
		return task.ErrUnknown
	}
	h.stdout, h.stderr = r.StdoutNext, r.StderrNext
	h.stdoutBytes, h.stderrBytes = r.StdoutBytes, r.StderrBytes
	events, parseErr := h.stream.Feed(r.Stdout)
	snapshot := h.stream.Snapshot()
	if snapshot.Observed.Evidence == "provider_reported" && !h.reference.Complete(task.Claude) {
		if progress == nil {
			return task.ErrUnknown // callbacks may not escape the dispatch lifetime
		}
		ref := task.Reference{SessionID: snapshot.Observed.SessionID, InvocationID: h.operation}
		if err := hostPublish(func() error { return progress(ref) }); err != nil {
			return task.ErrUnknown
		}
		h.reference = ref
		if err := h.event(ctx, task.ProviderStarted, ""); err != nil {
			return task.ErrUnknown
		}
	}
	// A valid init prefix is actual lineage even when a later record in the
	// same range fails. No failed-range output/result is released.
	if parseErr != nil {
		return task.ErrUnknown
	}
	// Matching init can retain partial lineage even when child outcome is
	// unknown. Useful text/result cannot turn unknown cohort facts into success.
	if r.State == "unknown" || r.OutputLimitReached || r.AuthorityLost || r.TimedOut || r.CancelRequested || r.GroupCleanup == "unverified" || r.DescendantCleanup == "unverified" {
		return task.ErrUnknown
	}
	for _, event := range events {
		if event.Kind == "output_delta" && h.output != nil {
			if !h.reference.Complete(task.Claude) {
				return task.ErrUnknown
			}
			if err := hostPublish(func() error { return h.output(ctx, h.reference, event.Text) }); err != nil {
				return task.ErrUnknown
			}
		}
	}
	if _, err := h.current(ctx, h.selected.binding); err != nil {
		return task.ErrUnknown
	}
	if !h.reference.Complete(task.Claude) {
		if r.State != "running" || r.RootState != "running" || r.RootWaited || r.ExitCode != nil || r.ExitSignal != 0 || r.OutputDrained || r.GroupCleanup != "pending" || r.DescendantCleanup != "pending" {
			return task.ErrUnknown
		}
		return nil
	}
	h.receipt = task.Receipt{State: task.Known, Reference: h.reference, Lifecycle: task.Running}
	if r.State != "terminal" {
		return nil
	}
	if r.RootState != "exited" || !r.RootWaited || !r.OutputDrained || r.GroupCleanup != "confirmed" || r.DescendantCleanup != "confirmed" {
		return task.ErrUnknown
	}
	// Drained is EOF at the owning child; unread retained bytes still require
	// further caller-driven reads. Never Finish the parser at a range boundary.
	if h.stdout != r.StdoutBytes || h.stderr != r.StderrBytes {
		return nil
	}
	if r.ExitCode == nil || *r.ExitCode < 0 || *r.ExitCode > 255 || r.ExitSignal != 0 || h.stream.Finish() != nil {
		return task.ErrUnknown
	}
	snapshot = h.stream.Snapshot()
	result := snapshot.ProviderResult
	if snapshot.Unknown || !snapshot.Ended || result == nil || result.Lifecycle == task.Completed && *r.ExitCode != 0 {
		return task.ErrUnknown
	}
	if !h.terminalEvent && result.Lifecycle != task.NeedsInput {
		if err := h.event(ctx, task.ProviderTerminal, result.Lifecycle); err != nil {
			return task.ErrUnknown
		}
		h.terminalEvent = true
	}
	h.receipt = task.Receipt{State: task.Known, Reference: h.reference, Lifecycle: result.Lifecycle, Result: result.Text}
	return nil
}

func hostRange(q port.ClaudeRead, r port.ClaudeObservation) bool {
	if r.Handle != q.Handle || len(r.Stdout) > StreamLimit || len(r.Stderr) > StreamLimit || r.StdoutNext != q.StdoutOffset+uint64(len(r.Stdout)) || r.StderrNext != q.StderrOffset+uint64(len(r.Stderr)) || r.StdoutNext > r.StdoutBytes || r.StderrNext > r.StderrBytes || r.StdoutBytes > 4<<20 || r.StderrBytes > (4<<20)-r.StdoutBytes {
		return false
	}
	if r.State != "running" && r.State != "terminal" && r.State != "unknown" || r.RootState != "running" && r.RootState != "exited" {
		return false
	}
	cleanup := func(s string) bool { return s == "pending" || s == "confirmed" || s == "unverified" }
	return cleanup(r.GroupCleanup) && cleanup(r.DescendantCleanup)
}

func (h *Host) event(ctx context.Context, kind task.EventKind, lifecycle task.Lifecycle) error {
	if h.events == nil {
		return nil
	}
	if _, err := h.current(ctx, h.selected.binding); err != nil {
		return task.ErrUnknown
	}
	now, err := hostCall(func() (uint64, error) { return h.now(), nil })
	if err != nil || now == 0 || now > 9007199254740991 {
		return task.ErrUnknown
	}
	h.sequence++
	e := task.ExecutionEvent{RunID: h.selected.scope.TaskID, DispatchID: h.operation, EventID: string(kind), StreamID: h.streamID, Generation: 1, SourceSequence: h.sequence, TimestampMillis: now, Kind: kind, Source: task.RuntimeEvidence, Reference: h.reference, ReportedLifecycle: lifecycle}
	if !e.Valid(task.Claude) {
		return task.ErrUnknown
	}
	return hostPublish(func() error { return h.events(ctx, e) })
}
