package workflow

import (
	"context"
	"encoding/json"
	"strings"
	"unicode/utf8"

	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

type Mode uint8

const (
	// Reconnect is observation only. Missing children stay unknown, not eligible.
	Reconnect Mode = iota
	// AdmitNew requires the caller's immutable plan and explicit runtime admission.
	AdmitNew
)

type DeliveryState string

const (
	DeliveryPending      DeliveryState = "pending"
	DeliveryAcknowledged DeliveryState = "acknowledged"
	DeliveryUnknown      DeliveryState = "outcome_unknown"
	DeliveryRefused      DeliveryState = "refused"
)

type CancellationState string

const (
	CancellationPending      CancellationState = "not_requested"
	CancellationAcknowledged CancellationState = "requested"
	CancellationUnknown      CancellationState = "outcome_unknown"
	CancellationRefused      CancellationState = "refused"
)

type Progress struct {
	StepID, TaskID, OperationID string
	State                       wf.State
	Accepted, CancelRequested   bool
	Delivery                    DeliveryState
	Cancellation                CancellationState
}
type Report struct {
	WorkflowID string
	Steps      []Progress
	Started    []string
}
type view struct {
	outcomes map[string]wf.Outcome
	outputs  map[string]string
	records  map[string]Record
}

func validRecord(r Record, taskID, operationID, action string) bool {
	if !r.Found {
		return r == (Record{})
	}
	if r.TaskID != taskID || r.OperationID != operationID || r.Action != action ||
		(r.State != Known && r.State != Unknown && r.State != Refused) {
		return false
	}
	if r.State != Known {
		return true
	}
	codex := wf.ID(r.Reference.ThreadID) && wf.ID(r.Reference.TurnID) && r.Reference.SessionID == "" && r.Reference.InvocationID == ""
	claude := wf.ID(r.Reference.SessionID) && wf.ID(r.Reference.InvocationID) && r.Reference.ThreadID == "" && r.Reference.TurnID == ""
	if !codex && !claude {
		return false
	}
	if action == "deliver" {
		return true
	}
	if action == "cancel" {
		return r.CancelRequested && r.Outcome == wf.Running
	}
	return r.Outcome == wf.Running || r.Outcome == wf.Completed || r.Outcome == wf.Failed || r.Outcome == wf.Cancelled || r.Outcome == wf.NeedsInput
}
func outcome(r Record, expectation wf.Output) wf.Outcome {
	o := wf.Outcome{State: wf.Unknown, CancelRequested: r.CancelRequested}
	if r.State == Unknown {
		return o
	}
	if r.State == Refused {
		o.State = wf.Unavailable
		return o
	}
	switch r.Outcome {
	case wf.Running, wf.NeedsInput, wf.Failed, wf.Cancelled:
		o.State = r.Outcome
	case wf.Completed:
		o.State = wf.Completed
		if len(r.Output) > expectation.MaxBytes || !utf8.ValidString(r.Output) ||
			expectation.Kind == wf.OutputJSON && !json.Valid([]byte(r.Output)) {
			o.State = wf.InvalidOutput
		} else {
			o.Accepted = true
		}
	}
	return o
}
func (s *Service) read(ctx context.Context, plan wf.Plan, mode Mode) view {
	v := view{map[string]wf.Outcome{}, map[string]string{}, map[string]Record{}}
	for _, step := range plan.Steps {
		r, err := s.tasks.Read(ctx, step.TaskID, step.OperationID)
		if err != nil || !validRecord(r, step.TaskID, step.OperationID, "create") {
			v.outcomes[step.ID] = wf.Outcome{State: wf.Unknown}
			continue
		}
		if !r.Found {
			state := wf.Waiting
			if mode == Reconnect {
				state = wf.Unknown
			}
			v.outcomes[step.ID] = wf.Outcome{State: state}
			continue
		}
		// Observe only a positively known running dispatch, never an unknown call.
		if r.State == Known && r.Outcome == wf.Running {
			observed, err := s.tasks.Observe(ctx, step.TaskID)
			if err != nil || observed.TaskID != step.TaskID || observed.DispatchID != step.OperationID || observed.Reference != r.Reference {
				v.outcomes[step.ID] = wf.Outcome{State: wf.Unknown}
				continue
			}
			// Retained original operation, rather than provider ACK, is final evidence.
			// Task's durable observation updates this operation before a successor runs.
			latest, err := s.tasks.Read(ctx, step.TaskID, step.OperationID)
			if err != nil || !validRecord(latest, step.TaskID, step.OperationID, "create") || !latest.Found || latest.State != Known || latest.Reference != r.Reference || latest.Outcome != observed.Outcome || latest.Output != observed.Output {
				v.outcomes[step.ID] = wf.Outcome{State: wf.Unknown}
				continue
			}
			if latest.Outcome == wf.Completed && !observed.Retained {
				v.outcomes[step.ID] = wf.Outcome{State: wf.Unknown}
				continue
			}
			r = latest
		}
		v.records[step.ID] = r
		v.outcomes[step.ID] = outcome(r, step.Output)
		if v.outcomes[step.ID].Accepted {
			v.outputs[step.ID] = r.Output
		}
		// Cancellation is a separate operation; a requested ACK isn't terminal.
		cancellation, err := s.tasks.Read(ctx, step.TaskID, step.CancelOperationID)
		if err != nil || !validRecord(cancellation, step.TaskID, step.CancelOperationID, "cancel") {
			o := v.outcomes[step.ID]
			o.CancelRequested = true
			v.outcomes[step.ID] = o
		} else if cancellation.Found && cancellation.State != Refused {
			o := v.outcomes[step.ID]
			o.CancelRequested = true
			v.outcomes[step.ID] = o
		}
	}
	return v
}
func (s *Service) report(ctx context.Context, p wf.Plan, v view) Report {
	out := Report{WorkflowID: p.ID}
	for _, step := range p.Steps {
		o := v.outcomes[step.ID]
		row := Progress{StepID: step.ID, TaskID: step.TaskID, OperationID: step.OperationID, State: o.State, Accepted: o.Accepted, CancelRequested: false, Cancellation: CancellationPending, Delivery: DeliveryPending}
		cancel, cancelErr := s.tasks.Read(ctx, step.TaskID, step.CancelOperationID)
		switch {
		case cancelErr != nil || !validRecord(cancel, step.TaskID, step.CancelOperationID, "cancel"):
			row.Cancellation = CancellationUnknown
		case cancel.Found && cancel.State == Known:
			original, found := v.records[step.ID]
			if found && cancel.Reference == original.Reference {
				row.Cancellation = CancellationAcknowledged
				row.CancelRequested = true
			} else {
				row.Cancellation = CancellationUnknown
			}
		case cancel.Found && cancel.State == Refused:
			row.Cancellation = CancellationRefused
		case cancel.Found:
			row.Cancellation = CancellationUnknown
		}
		r, err := s.tasks.Read(ctx, step.TaskID, step.DeliveryOperationID)
		switch {
		case err != nil || !validRecord(r, step.TaskID, step.DeliveryOperationID, "deliver"):
			row.Delivery = DeliveryUnknown
		case r.Found && r.State == Known:
			// A delivery receipt is independent from the child completion receipt.
			original, found := v.records[step.ID]
			if found && r.Reference == original.Reference {
				row.Delivery = DeliveryAcknowledged
			} else {
				row.Delivery = DeliveryUnknown
			}
		case r.Found && r.State == Refused:
			row.Delivery = DeliveryRefused
		case r.Found:
			row.Delivery = DeliveryUnknown
		}
		out.Steps = append(out.Steps, row)
	}
	return out
}
func (s *Service) check(ctx context.Context, p wf.Plan) error {
	if ctx == nil {
		return ErrInvalid
	}
	if s == nil || s.tasks == nil || s.composer == nil || s.admission == nil {
		return ErrUnavailable
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if wf.Validate(p) != nil {
		return ErrInvalid
	}
	return nil
}

// Tick performs one finite scheduling round. There are no goroutines, waits,
// timers, retries, persistence maps or automatic parent delivery in this service.
// Caller-owned activation controls whether new known-missing work is admitted.
func (s *Service) Tick(ctx context.Context, p wf.Plan, budget wf.Budget, mode Mode) (Report, error) {
	if err := s.check(ctx, p); err != nil {
		return Report{}, err
	}
	if mode != Reconnect && mode != AdmitNew || budget.Slots < 0 {
		return Report{}, ErrInvalid
	}
	v := s.read(ctx, p, mode)
	remaining := budget.Slots
	for _, o := range v.outcomes {
		if o.State == wf.Running || o.State == wf.Unknown {
			remaining--
		}
	}
	candidates := budget
	// Read-only per-provider capability refusals don't consume a launch slot or
	// starve later independent work. The actual budget still bounds callbacks.
	candidates.Slots = 2 * len(p.Steps)
	ready := wf.Ready(p, v.outcomes, candidates)
	if remaining <= 0 || budget.Paused || budget.ParentClosed {
		ready = nil
	}
	started := []string{}
	if mode == AdmitNew {
		for _, id := range ready {
			if ctx.Err() != nil || remaining <= 0 {
				break
			}
			var step wf.Step
			for _, candidate := range p.Steps {
				if candidate.ID == id {
					step = candidate
					break
				}
			}
			deps := map[string]string{}
			for _, dep := range step.Dependencies {
				deps[dep] = v.outputs[dep]
			}
			selection, message, err := s.composer.Compose(ctx, step, deps)
			if err != nil {
				v.outcomes[id] = wf.Outcome{State: wf.NeedsInput}
				continue
			}
			if message == "" || len(message) > 32768 || !utf8.ValidString(message) || strings.ContainsRune(message, 0) {
				v.outcomes[id] = wf.Outcome{State: wf.InvalidOutput}
				continue
			}
			caps, err := s.tasks.Resolve(ctx, selection)
			available := err == nil && caps[wf.CapabilityCreate]
			for _, required := range step.Required {
				available = available && caps[required]
			}
			if !available {
				v.outcomes[id] = wf.Outcome{State: wf.Unavailable}
				continue
			}
			called := false
			var r Record
			err = s.admission.Do(ctx, p.Parent, step.TaskID, func() error {
				if called {
					return ErrState
				}
				called = true
				var effectErr error
				r, effectErr = s.tasks.Create(ctx, Launch{TaskID: step.TaskID, OperationID: step.OperationID, Message: message, Selection: selection, Parent: p.Parent})
				return effectErr
			})
			if !called {
				v.outcomes[id] = wf.Outcome{State: wf.Unavailable}
				continue
			}
			remaining--
			started = append(started, id)
			if err != nil || !r.Found || !validRecord(r, step.TaskID, step.OperationID, "create") {
				v.outcomes[id] = wf.Outcome{State: wf.Unknown}
				continue
			}
			v.records[id] = r
			v.outcomes[id] = outcome(r, step.Output)
		}
	}
	out := s.report(ctx, p, v)
	out.Started = started
	if ctx.Err() != nil {
		return out, ctx.Err()
	}
	return out, nil
}

// Cancel requests supported cancellation of known running children. Closed-parent
// admission still belongs to Task; failure never becomes terminal evidence.
func (s *Service) Cancel(ctx context.Context, p wf.Plan) (Report, error) {
	if err := s.check(ctx, p); err != nil {
		return Report{}, err
	}
	v := s.read(ctx, p, Reconnect)
	for _, step := range p.Steps {
		o := v.outcomes[step.ID]
		if o.State != wf.Running || o.CancelRequested {
			continue
		}
		original, err := s.tasks.Read(ctx, step.TaskID, step.CancelOperationID)
		if err != nil || !validRecord(original, step.TaskID, step.CancelOperationID, "cancel") || original.Found {
			continue
		}
		r, err := s.tasks.Cancel(ctx, Target{TaskID: step.TaskID, OperationID: step.CancelOperationID, ExpectedDispatchID: step.OperationID, Reference: v.records[step.ID].Reference})
		// Treat ambiguous cancellation as requested; never send it again via another key.
		o.CancelRequested = true
		if err == nil && validRecord(r, step.TaskID, step.CancelOperationID, "cancel") && r.Found && r.State == Refused {
			o.CancelRequested = false
		}
		v.outcomes[step.ID] = o
	}
	return s.report(ctx, p, v), nil
}

// Deliver sends accepted completions and known failed/interrupted/needs-input
// outcomes through Task's original durable parent route. Merely reading progress never sends or acknowledges a result.
func (s *Service) Deliver(ctx context.Context, p wf.Plan) (Report, error) {
	if err := s.check(ctx, p); err != nil {
		return Report{}, err
	}
	v := s.read(ctx, p, Reconnect)
	for _, step := range p.Steps {
		o := v.outcomes[step.ID]
		if !o.Accepted && o.State != wf.Failed && o.State != wf.Cancelled && o.State != wf.NeedsInput {
			continue
		}
		r, err := s.tasks.Read(ctx, step.TaskID, step.DeliveryOperationID)
		if err != nil || !validRecord(r, step.TaskID, step.DeliveryOperationID, "deliver") || r.Found {
			continue
		}
		// Ignore the outward ACK: the report reads the original durable operation.
		_, _ = s.tasks.Deliver(ctx, Target{TaskID: step.TaskID, OperationID: step.DeliveryOperationID, ExpectedDispatchID: step.OperationID, Reference: v.records[step.ID].Reference})
	}
	return s.report(ctx, p, v), nil
}

// Follow is explicit caller-selected continuation, never automatic crash resume.
// The caller must retain this operation ID and obtain a fresh upstream selected
// Task route. It cannot change the immutable workflow's original dispatch.
func (s *Service) Follow(ctx context.Context, p wf.Plan, stepID string, request Followup) (Record, error) {
	if err := s.check(ctx, p); err != nil {
		return Record{}, err
	}
	var step wf.Step
	for _, candidate := range p.Steps {
		if candidate.ID == stepID {
			step = candidate
			break
		}
	}
	if step.ID == "" || request.TaskID != step.TaskID || request.ExpectedDispatchID != step.OperationID || !wf.ID(request.OperationID) || request.OperationID == step.OperationID || request.OperationID == step.CancelOperationID || request.OperationID == step.DeliveryOperationID || request.Message == "" || len(request.Message) > 32768 || !utf8.ValidString(request.Message) || strings.ContainsRune(request.Message, 0) {
		return Record{}, ErrInvalid
	}
	// No selected operation may collide with any other workflow step.
	for _, other := range p.Steps {
		if request.OperationID == other.OperationID || request.OperationID == other.CancelOperationID || request.OperationID == other.DeliveryOperationID {
			return Record{}, ErrInvalid
		}
	}
	prior, err := s.tasks.Read(ctx, step.TaskID, request.OperationID)
	action := "continue"
	if request.Resume {
		action = "resume"
	}
	if err != nil || !validRecord(prior, step.TaskID, request.OperationID, action) {
		return Record{}, ErrUnknown
	}
	if prior.Found {
		// Read does not verify a newly supplied message fingerprint. Return the
		// original evidence with refusal, rather than attributing it to new content.
		// ReadFollowup is the explicit content-free reconnect path.
		return prior, ErrState
	}
	old, err := s.tasks.Read(ctx, step.TaskID, step.OperationID)
	if err != nil || !validRecord(old, step.TaskID, step.OperationID, "create") || !old.Found || old.State != Known || (old.Outcome != wf.Completed && old.Outcome != wf.Failed && old.Outcome != wf.Cancelled) {
		return Record{}, ErrState
	}
	delivered, err := s.tasks.Read(ctx, step.TaskID, step.DeliveryOperationID)
	if err != nil || !validRecord(delivered, step.TaskID, step.DeliveryOperationID, "deliver") || !delivered.Found || delivered.State != Known || delivered.Reference != old.Reference {
		return Record{}, ErrState
	}
	called := false
	var result Record
	err = s.admission.Do(ctx, p.Parent, step.TaskID, func() error {
		if called {
			return ErrState
		}
		called = true
		var effectErr error
		result, effectErr = s.tasks.Followup(ctx, request)
		return effectErr
	})
	if err != nil || !called || !result.Found || !validRecord(result, step.TaskID, request.OperationID, action) {
		return Record{}, ErrUnknown
	}
	return result, nil
}

// ReadFollowup returns only original evidence, without accepting a new message,
// dispatching, restoring admission or silently validating changed content.
func (s *Service) ReadFollowup(ctx context.Context, p wf.Plan, stepID, operationID string, resume bool) (Record, error) {
	if err := s.check(ctx, p); err != nil {
		return Record{}, err
	}
	if !wf.ID(operationID) {
		return Record{}, ErrInvalid
	}
	var step wf.Step
	for _, candidate := range p.Steps {
		if operationID == candidate.OperationID || operationID == candidate.CancelOperationID || operationID == candidate.DeliveryOperationID {
			return Record{}, ErrInvalid
		}
		if candidate.ID == stepID {
			step = candidate
		}
	}
	if step.ID == "" {
		return Record{}, ErrInvalid
	}
	action := "continue"
	if resume {
		action = "resume"
	}
	r, err := s.tasks.Read(ctx, step.TaskID, operationID)
	if err != nil || !validRecord(r, step.TaskID, operationID, action) {
		return Record{}, ErrUnknown
	}
	return r, nil
}
