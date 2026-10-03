// Package provider owns per-dispatch callback serialization, not provider
// selection, task admission, transport, retry or shared lifecycle state.
package provider

import (
	"context"
	"sync"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

type progress struct {
	mu      sync.Mutex
	record  func(context.Context, task.Reference) error
	closed  bool
	failure error
}

var _ port.ProgressFactory = NewProgress
var _ port.Progress = (*progress)(nil)

func NewProgress(record func(context.Context, task.Reference) error) port.Progress {
	return &progress{record: record}
}

func (p *progress) Record(ctx context.Context, ref task.Reference) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return task.ErrUnknown
	}
	if p.failure != nil {
		return p.failure
	}
	if p.record == nil {
		p.failure = task.ErrUnavailable
	} else if err := ctx.Err(); err != nil {
		p.failure = err
	} else {
		p.failure = p.record(ctx, ref)
	}
	return p.failure
}

func (p *progress) Close(inspect func() error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return task.ErrUnknown
	}
	p.closed = true
	if p.failure != nil {
		return p.failure
	}
	if p.record == nil || inspect == nil {
		return task.ErrUnavailable
	}
	return inspect()
}
