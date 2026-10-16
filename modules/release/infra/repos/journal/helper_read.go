package journal

import (
	"context"
	"errors"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/repos/records"
)

var _ port.HelperJournalRepository = (*Repo)(nil)

// ReadHelper observes physical bytes only; it grants no helper exit, startup or
// effect authority and never changes retained uncertainty or borrowed ownership.
func (r *Repo) ReadHelper(ctx context.Context) (*port.JournalView, error) {
	return r.readHelper(ctx, r.readWithOptions)
}

// query is a per-call test seam. Production always uses the shared native read.
func (r *Repo) readHelper(ctx context.Context, query func(readOptions) (*observation, error)) (view *port.JournalView, result error) {
	if ctx == nil {
		return nil, port.JournalInvalid
	}
	until, ok := ctx.Deadline()
	if !ok || until.IsZero() {
		return nil, port.JournalInvalid
	}
	bound := func() error {
		cause := ctx.Err()
		// Timer delivery can lag. Never renew or re-read the original deadline.
		if !time.Now().Before(until) {
			cause = errors.Join(cause, context.DeadlineExceeded)
		}
		if cause != nil {
			return errors.Join(port.JournalCancelled, cause)
		}
		return nil
	}
	r.gate.Lock()
	defer r.gate.Unlock()
	// Wait for the query's actual synchronous return (including its cleanup),
	// then retain its failure alongside cancellation before releasing the gate.
	defer func() {
		if err := bound(); err != nil {
			view = nil
			result = errors.Join(result, err)
		}
	}()
	if err := bound(); err != nil {
		return nil, err
	}
	if r.closed {
		return nil, port.JournalClosed
	}
	observed, err := query(readOptions{maxBytes: records.MaxHelperRecordBytes, bound: bound})
	if err != nil {
		return nil, err
	}
	return observed.view, nil
}
