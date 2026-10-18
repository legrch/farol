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
	defer func() {
		if p := recover(); p != nil {
			admission.RetainJournalUnknown(op)
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
	var entered error
	err = raw.Control(func(uintptr) {
		r, e := openRepository(ctx, directory, op, nil, admission)
		if e != nil {
			entered = e
			return
		}
		defer func() {
			cleanup := r.Close() // joins the original serialization gate
			if cleanup != nil {
				admission.RetainJournalUnknown(op)
			}
			entered = joinObservationResults(entered, cleanup)
		}()
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
		if err := fn(&Observation{repo: r}); err != nil {
			entered = journalFailure(port.JournalUnavailable, err)
		}
	})
	if err != nil {
		err = journalFailure(port.JournalUnavailable, err)
	}
	result = joinObservationResults(entered, err)
	if result != nil || ctx.Err() != nil || !time.Now().Before(until) {
		// Do not let another reader/adaptor reopen uncertainty in this owner.
		admission.RetainJournalUnknown(op)
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
type Observation struct{ repo *Repo }

func (o *Observation) ReadHelper(ctx context.Context) (*port.JournalView, error) {
	if o == nil || o.repo == nil {
		return nil, port.JournalInvalid
	}
	return o.repo.ReadHelper(ctx)
}
