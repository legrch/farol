package execution

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
)

// WithInstallation exposes installation ports only under the same real route
// borrow and original owner as With. The caller retains both repositories and
// their shared admission through actual return; no descriptor or owner closes.
func WithInstallation(ctx context.Context, config Config, fn func(port.HelperInstallationRuntime) error) error {
	return withInstallation(ctx, config, config.Files.Reverify, fn)
}

// The route seam remains private and grants no production alternate root.
func withInstallation(ctx context.Context, config Config, routes func(context.Context) error, fn func(port.HelperInstallationRuntime) error) error {
	if config.Rejection == nil || fn == nil {
		return fail("internal", true, false, nil)
	}
	return with(ctx, config, routes, func(native port.HelperRecoveryRuntime) error {
		// with constructs only this package's concrete runtime. The adapter
		// does not accept a caller-supplied recovery port as native authority.
		return fn(native.(*runtime))
	})
}

func (r *runtime) Prepare(ctx context.Context) error {
	return r.invoke(ctx, "journal:prepared", func(c context.Context) error {
		if err := r.fence(c); err != nil {
			return err
		}
		view, err := r.config.Journal.ReadHelper(c)
		if err != nil {
			return err
		}
		if view == nil || view.Revision == "" {
			return fail("journal_invalid", false, false, nil)
		}
		if view.Value != nil {
			return fail("operation_exists", false, false, nil)
		}
		// A physical absence is only this CAS witness. The original repository
		// rechecks the same admission, gate and namespace before any write.
		if err := r.fence(c); err != nil {
			return err
		}
		return r.persistJournal(c, view.Revision, "prepared")
	})
}

func (r *runtime) RejectTarget(ctx context.Context, expected port.HelperIdentity) error {
	return r.invoke(ctx, "rejected-target", func(c context.Context) error {
		if r.config.Rejection == nil {
			return fail("internal", true, false, nil)
		}
		if err := r.fence(c); err != nil {
			return err
		}
		if err := r.config.Rejection.Record(c, expected); err != nil {
			return err
		}
		r.effected = true
		return r.persistedFence(c)
	})
}
