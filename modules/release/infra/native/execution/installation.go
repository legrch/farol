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

// AdmittedInstallation is the installation runtime together with its read-only
// projection: the exact pair the application Milestone's AdmittedRuntime asks
// for. It is declared here, structurally, so this package never imports the
// application service. The value is the package's one concrete runtime.
type AdmittedInstallation interface {
	port.HelperInstallationRuntime
	port.HelperInstallationObservation
}

var _ AdmittedInstallation = (*runtime)(nil)

// WithAdmittedInstallation exposes the installation runtime under the same real
// route borrow, original owner and joined return as WithInstallation. It adds no
// authority: the callback receives the very runtime WithInstallation constructs,
// through its read-only projection as well, so trusted composition need not
// type-assert a port. It is scoped, single-owner and unusable after return.
func WithAdmittedInstallation(ctx context.Context, config Config, fn func(AdmittedInstallation) error) error {
	return withAdmittedInstallation(ctx, config, config.Files.Reverify, fn)
}

func withAdmittedInstallation(ctx context.Context, config Config, routes func(context.Context) error, fn func(AdmittedInstallation) error) error {
	if fn == nil {
		return fail("internal", true, false, nil)
	}
	return withInstallation(ctx, config, routes, func(native port.HelperInstallationRuntime) error {
		// withInstallation hands out only this package's concrete runtime, which
		// also implements the read-only projection. A failed assertion is an
		// internal defect, never a weaker substitute.
		admitted, ok := native.(AdmittedInstallation)
		if !ok {
			return fail("internal", true, false, nil)
		}
		return fn(admitted)
	})
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
