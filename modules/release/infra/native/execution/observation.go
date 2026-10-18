package execution

import (
	"context"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
)

// ObservationConfig borrows only the existing bounded physical reader. It
// contains no writer, rejection repository or mutation admission. Construction
// does not qualify that reader's original admission or a trusted launcher; the
// same real operation owner must supply both independently. No default reader
// or weakened JournalAdmission is manufactured for a pre-ACK call.
type ObservationConfig struct {
	Request       port.HelperRequest
	Files         helperroutes.Files
	Journal       port.HelperJournalObservationReader
	Until         time.Time
	Reverify      func(context.Context, port.HelperRequest) error
	Unknown       func() error
	RetainUnknown func(error)
}

// WithObservation provides only a sealed read-only projection for actual
// pre-ACK application observations. It joins entered native returns and cleanup
// just like With. Copies cannot gain a writer or retain use after scope closure.
func WithObservation(ctx context.Context, c ObservationConfig, fn func(port.HelperInstallationObservation) error) error {
	return withObservation(ctx, c, c.Files.Reverify, fn)
}

func withObservation(ctx context.Context, c ObservationConfig, routes func(context.Context) error, fn func(port.HelperInstallationObservation) error) error {
	if fn == nil {
		return fail("internal", true, false, nil)
	}
	config := Config{Request: c.Request, Files: c.Files, Until: c.Until, Reverify: c.Reverify, Unknown: c.Unknown, RetainUnknown: c.RetainUnknown}
	return withReader(ctx, config, c.Journal, routes, func(native port.HelperRecoveryRuntime) error {
		return fn(observation{native.(*runtime)})
	})
}

type observation struct{ owner *runtime }

var _ port.HelperInstallationObservation = observation{}

func (o observation) ReadJournal(ctx context.Context) (*port.JournalView, error) {
	return o.owner.ReadJournal(ctx)
}
func (o observation) ReadPhase(ctx context.Context) (string, error) {
	// The admitted ReadPhase deliberately seeds its writer CAS cursor. Preflight
	// instead uses the existing bounded, fenced reader without retaining a revision.
	view, err := o.owner.ReadJournal(ctx)
	if err != nil {
		return "", err
	}
	if view.Value == nil {
		return "", fail("journal_invalid", false, false, nil)
	}
	return view.Value.Phase, nil
}
func (o observation) Entries(ctx context.Context) (port.HelperRecoveryEntries, error) {
	return o.owner.Entries(ctx)
}
func (o observation) MatchesTree(ctx context.Context, e port.HelperRecoveryEntry, b port.HelperBuild) (bool, error) {
	return o.owner.MatchesTree(ctx, e, b)
}
func (o observation) VerifyTree(ctx context.Context, e port.HelperRecoveryEntry, b port.HelperBuild) error {
	return o.owner.VerifyTree(ctx, e, b)
}

// ReadJournal observes absence/presence without setting the runtime's writer
// revision. Prepare and ReadPhase retain their original admitted CAS chains.
func (r *runtime) ReadJournal(ctx context.Context) (*port.JournalView, error) {
	var copied *port.JournalView
	err := r.invoke(ctx, "", func(c context.Context) error {
		if err := r.fence(c); err != nil {
			return err
		}
		view, err := r.reader.ReadHelper(c)
		if err != nil {
			return err
		}
		if view == nil || view.Revision == "" {
			return fail("journal_invalid", false, false, nil)
		}
		v := *view
		if view.Value != nil {
			value := *view.Value
			if value.Operation != operation(r.config.Request) {
				return fail("journal_mismatch", false, false, nil)
			}
			v.Value = &value
		}
		copied = &v
		return r.fence(c)
	})
	if err != nil {
		return nil, err
	}
	return copied, nil
}
