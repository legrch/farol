// Package exchange is the reverse-poll queue of one inherited host pipe. The
// backend registers one-shot calls; the desktop polls for their commands, runs
// them and posts each result once. The queue is transport correlation only: it
// never retries, redelivers or reissues a command, and it owns no admission,
// intent or result policy of its consumers.
package exchange

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"time"
)

// MaxWait bounds every poll and command deadline accepted by Deadline.
const MaxWait = 15 * time.Second

// maxMillis is the largest integer a JSON number carries exactly.
const maxMillis = 1<<53 - 1

var (
	// ErrDeadline refuses a wire deadline that is past, too far ahead or not
	// representable.
	ErrDeadline = errors.New("exchange_deadline_invalid")
	// ErrUnavailable refuses a poll whose caller, queue lifetime or fence
	// rules out delivery, and an invalid construction.
	ErrUnavailable = errors.New("exchange_unavailable")
	// ErrFenced refuses a call after the queue was fenced.
	ErrFenced = errors.New("exchange_fenced")
	// ErrQuiesced refuses a call after polling was quiesced.
	ErrQuiesced = errors.New("exchange_quiesced")
	// ErrSaturated refuses a call while the live-call bound is reached.
	ErrSaturated = errors.New("exchange_saturated")
	// ErrDuplicate refuses a call whose command ID is already live.
	ErrDuplicate = errors.New("exchange_duplicate")
	// ErrNotCurrent refuses a completion that no live delivered call awaits.
	ErrNotCurrent = errors.New("exchange_not_current")
	// ErrNotQuiescent refuses quiescence while a call is live, after a fence
	// or after the queue lifetime ended.
	ErrNotQuiescent = errors.New("exchange_not_quiescent")
)

// Command is one delivered unit of work. ID is the caller's one-shot
// correlation; Body is opaque to the queue.
type Command struct {
	ID   string
	Kind string
	Body json.RawMessage
}

// State is an observation of the queue. It grants no custody of any call.
type State struct {
	// Issued counts registered calls this lifetime. It is never a quota.
	Issued uint64
	// Live counts registered calls that are not released.
	Live int
	// Waiting holds copies of live commands not yet delivered, in order.
	Waiting  []Command
	Quiesced bool
	Fenced   bool
}

type answer[R any] struct {
	value R
	err   error
}

// Call is one registered command and its single answer. Its owner must
// settle it exactly once with Release or Fence after Wait returns.
type Call[R any] struct {
	queue                *Queue[R]
	command              Command
	ctx                  context.Context
	cancel               context.CancelFunc
	delivered, completed bool
	answer               chan answer[R]
}

// Queue holds at most limit live calls. Memory is bounded by those live calls:
// a settled call leaves the queue, and a later reply for its ID is refused.
// Readiness is only a wake-up; a command stays with its call until a poll
// admits it under the lock.
type Queue[R any] struct {
	ctx              context.Context
	limit            int
	mu               sync.Mutex
	calls            []*Call[R] // live calls in registration order
	changed          chan struct{}
	stopped          chan struct{}
	issued           uint64
	fenced, quiesced bool
}

// New returns a queue for one transport lifetime bounded by ctx.
func New[R any](ctx context.Context, limit int) (*Queue[R], error) {
	if ctx == nil || ctx.Err() != nil || limit < 1 {
		return nil, ErrUnavailable
	}
	return &Queue[R]{ctx: ctx, limit: limit, changed: make(chan struct{}), stopped: make(chan struct{})}, nil
}

// Deadline converts a wire deadline in Unix milliseconds into an instant that
// lies in the future and no more than MaxWait ahead.
func Deadline(millis uint64) (time.Time, error) {
	if millis > maxMillis {
		return time.Time{}, ErrDeadline
	}
	until := time.UnixMilli(int64(millis))
	if remaining := time.Until(until); remaining <= 0 || remaining > MaxWait {
		return time.Time{}, ErrDeadline
	}
	return until, nil
}

// Submit registers command as a one-shot call. A poll may deliver it only
// while the call context, bounded by until and by ctx, is live. Submit does
// not check the queue lifetime: Wait observes it.
func (q *Queue[R]) Submit(ctx context.Context, until time.Time, command Command) (*Call[R], error) {
	if ctx == nil {
		return nil, ErrUnavailable
	}
	callCtx, cancel := context.WithDeadline(ctx, until)
	call := &Call[R]{queue: q, command: command, ctx: callCtx, cancel: cancel, answer: make(chan answer[R], 1)}
	q.mu.Lock()
	err := q.admit(command.ID)
	if err == nil {
		q.issued++
		q.calls = append(q.calls, call)
		// A wake-up, not custody: every sleeping poll rechecks under the lock.
		close(q.changed)
		q.changed = make(chan struct{})
	}
	q.mu.Unlock()
	if err != nil {
		cancel()
		return nil, err
	}
	return call, nil
}

func (q *Queue[R]) admit(id string) error {
	switch {
	case q.fenced:
		return ErrFenced
	case q.quiesced:
		return ErrQuiesced
	case len(q.calls) >= q.limit:
		return ErrSaturated
	case q.find(id) != nil:
		return ErrDuplicate
	}
	return nil
}

func (q *Queue[R]) find(id string) *Call[R] {
	for _, call := range q.calls {
		if call.command.ID == id {
			return call
		}
	}
	return nil
}

// Wait returns the call's answer, or the error of whichever ends first: the
// call context or the queue lifetime. An answer that arrives together with an
// ended context may win; callers that need a strict deadline check Err.
func (c *Call[R]) Wait() (R, error) {
	select {
	case result := <-c.answer:
		return result.value, result.err
	case <-c.ctx.Done():
		var zero R
		return zero, c.ctx.Err()
	case <-c.queue.ctx.Done():
		var zero R
		return zero, c.queue.ctx.Err()
	}
}

// Err reports whether the call context has ended.
func (c *Call[R]) Err() error { return c.ctx.Err() }

// Release removes the call from the queue. Its ID is never reissued, so a late
// reply is refused.
func (c *Call[R]) Release() { c.settle(false) }

// Fence removes the call and fences the queue in one step, so no other call
// can take its slot first. A fenced queue refuses every later call, poll,
// completion and quiescence for its whole lifetime.
func (c *Call[R]) Fence() { c.settle(true) }

func (c *Call[R]) settle(fence bool) {
	q := c.queue
	q.mu.Lock()
	if i := slices.Index(q.calls, c); i >= 0 {
		q.calls = slices.Delete(q.calls, i, i+1)
	}
	if fence {
		q.fenced = true
	}
	q.mu.Unlock()
	c.cancel()
}

// Fence fences the queue for its whole lifetime.
func (q *Queue[R]) Fence() {
	q.mu.Lock()
	q.fenced = true
	q.mu.Unlock()
}

// Next waits until until for one command and marks it delivered. It returns
// nil without error when the poll expires, polling is quiesced or the caller
// context ends with its deadline. The poll and call deadlines are checked
// again under the lock that delivers: select does not prioritize an ended
// context over a ready command, and a timer may not have fired yet. An
// expired poll leaves every command untouched for a later poll.
func (q *Queue[R]) Next(ctx context.Context, until time.Time) (*Command, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, ErrUnavailable
	}
	wait, cancel := context.WithDeadline(ctx, until)
	defer cancel()
	for {
		q.mu.Lock()
		if ctx.Err() != nil || q.ctx.Err() != nil || q.fenced {
			q.mu.Unlock()
			return nil, ErrUnavailable
		}
		now := time.Now()
		if q.quiesced || wait.Err() != nil || !now.Before(until) {
			q.mu.Unlock()
			return nil, nil
		}
		if command := q.deliver(now); command != nil {
			q.mu.Unlock()
			return command, nil
		}
		changed := q.changed
		q.mu.Unlock()
		select {
		case <-q.stopped:
			return nil, nil
		case <-q.ctx.Done():
			return nil, q.ctx.Err()
		case <-wait.Done():
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, nil
		case <-changed:
		}
	}
}

// deliver marks the oldest deliverable call delivered. The caller holds mu.
func (q *Queue[R]) deliver(now time.Time) *Command {
	for _, call := range q.calls {
		if call.delivered || call.completed || call.ctx.Err() != nil {
			continue
		}
		if deadline, bounded := call.ctx.Deadline(); !bounded || !now.Before(deadline) {
			continue
		}
		call.delivered = true
		command := call.command
		command.Body = append(json.RawMessage(nil), command.Body...)
		return &command
	}
	return nil
}

// Complete accepts the one reply for a delivered live call. The call is
// consumed before accept runs, so a malformed or crossed reply cannot be
// corrected by another completion. accept runs under the queue lock, must not
// call the queue and must not retain sent. Its result is the call's answer and
// its error is returned.
func (q *Queue[R]) Complete(id string, accept func(sent Command) (R, error)) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	call := q.find(id)
	if call == nil || !call.delivered || call.completed || call.ctx.Err() != nil || q.ctx.Err() != nil || q.fenced {
		return ErrNotCurrent
	}
	call.completed = true
	value, err := accept(call.command)
	call.answer <- answer[R]{value: value, err: err}
	return err
}

// Quiesce stops polling after the consumers' owners retire: it wakes idle
// polls without ending the queue lifetime. It proves transport quiescence only
// and cannot be reversed.
func (q *Queue[R]) Quiesce() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.ctx.Err() != nil || len(q.calls) != 0 || q.fenced {
		return ErrNotQuiescent
	}
	if !q.quiesced {
		q.quiesced = true
		close(q.stopped)
	}
	return nil
}

// State returns an observation of the queue.
func (q *Queue[R]) State() State {
	q.mu.Lock()
	defer q.mu.Unlock()
	state := State{Issued: q.issued, Live: len(q.calls), Quiesced: q.quiesced, Fenced: q.fenced}
	for _, call := range q.calls {
		if !call.delivered && !call.completed {
			command := call.command
			command.Body = append(json.RawMessage(nil), command.Body...)
			state.Waiting = append(state.Waiting, command)
		}
	}
	return state
}
