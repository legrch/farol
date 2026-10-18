package journal

import (
	"context"
	"errors"
	"os"
	"strconv"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
)

// WithObservation opens only the existing original operation. The physical
// route File is borrowed through callback, entered reads and actual cleanup.
// Its sealed projection exposes no CAS, prepare, repair or writer constructor.
// The same operation owner must later prove full JournalAdmission and REOBSERVE
// under its update/instance exclusion before the first effect.
func WithObservation(ctx context.Context, directory string, borrowed *os.File, binding port.JournalDirectory, op release.Operation, admission port.HelperJournalObservationAdmission, fn func(*Observation) error) (result error) {
	if ctx == nil || borrowed == nil || admission == nil || fn == nil {
		return port.JournalInvalid
	}
	gate := admission.JournalGate()
	if gate == nil {
		return port.JournalInvalid
	}
	retainUnknown := func() {
		gate.Lock()
		defer gate.Unlock()
		admission.RetainJournalUnknown(op)
	}
	defer func() {
		if p := recover(); p != nil {
			retainUnknown()
			panic(p)
		}
	}()
	until, ok := ctx.Deadline()
	if !ok || until.IsZero() || !time.Now().Before(until) || ctx.Err() != nil {
		return port.JournalCancelled
	}
	raw, err := borrowed.SyscallConn()
	if err != nil {
		return journalFailure(port.JournalUnavailable, err)
	}
	// Construction waits on the same gate. Its Err checks must observe the
	// captured absolute end even when the original timer notification lags.
	scoped := observationContext{Context: ctx, original: ctx, until: until}
	var entered error
	err = raw.Control(func(uintptr) {
		r, e := openRepository(scoped, directory, op, nil, admission)
		if e != nil {
			entered = e
			return
		}
		defer func() {
			cleanup := r.Close() // joins the original serialization gate
			// Close itself retains cleanup uncertainty under this same gate.
			entered = joinObservationResults(entered, cleanup)
		}()
		if err := scoped.Err(); err != nil {
			entered = errors.Join(port.JournalCancelled, err)
			return
		}
		info, e := borrowed.Stat()
		if e != nil {
			entered = journalFailure(port.JournalChanged, e)
			return
		}
		state, valid := metadata(info)
		if !valid || !privateDirectory(info, state) || r.identity() != binding ||
			strconv.FormatUint(state.Device, 10) != binding.Device || strconv.FormatUint(state.Inode, 10) != binding.Inode || state.directoryObject() != r.directory {
			entered = port.JournalChanged
			return
		}
		if !time.Now().Before(until) || ctx.Err() != nil {
			entered = errors.Join(port.JournalCancelled, ctx.Err())
			return
		}
		if err := fn(&Observation{repo: r, original: ctx, until: until}); err != nil {
			entered = journalFailure(port.JournalUnavailable, err)
		}
	})
	if err != nil {
		err = journalFailure(port.JournalUnavailable, err)
	}
	result = joinObservationResults(entered, err)
	if result != nil || ctx.Err() != nil || !time.Now().Before(until) {
		// Publish scope uncertainty under the same gate as admission and reads.
		retainUnknown()
		result = errors.Join(result, ctx.Err())
		if !time.Now().Before(until) {
			result = errors.Join(result, context.DeadlineExceeded)
		}
	}
	return result
}

func joinObservationResults(all ...error) error {
	var causes []error
	for _, err := range all {
		if err != nil {
			causes = append(causes, err)
		}
	}
	if len(causes) == 0 {
		return nil
	}
	if len(causes) == 1 {
		return causes[0]
	}
	return journalFailure(port.JournalUnavailable, causes...)
}

// Observation borrows a read-only view of one repository scope. Copies share
// the original serialization gate and refuse after that scope closes.
// Its zero value has no repository or native authority.
type Observation struct {
	repo     *Repo
	original context.Context
	until    time.Time
}

func (o *Observation) ReadHelper(ctx context.Context) (*port.JournalView, error) {
	if o == nil || o.repo == nil || o.original == nil || o.until.IsZero() || ctx == nil {
		return nil, port.JournalInvalid
	}
	if until, ok := ctx.Deadline(); !ok || until.IsZero() {
		return nil, port.JournalInvalid
	}
	bounded, cancel := context.WithDeadline(ctx, o.until)
	stop := context.AfterFunc(o.original, cancel)
	defer stop()
	defer cancel()
	return o.repo.ReadHelper(observationContext{Context: bounded, original: o.original, until: o.until})
}

// Keep the enclosing cancellation and captured absolute deadline in every
// existing repository bound check, including before/after synchronous I/O.
// Err enforces expiry even when context timer notification has not arrived.
type observationContext struct {
	context.Context
	original context.Context
	until    time.Time
}

func (c observationContext) Err() error {
	if err := c.original.Err(); err != nil {
		return err
	}
	if !time.Now().Before(c.until) {
		return context.DeadlineExceeded
	}
	return c.Context.Err()
}
