package execution

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
)

// Readiness retains observations, never an effect/admission capability. Its
// private values cannot be synthesized from matching public journal fields.
// Closed rollback additionally binds the exact original revision and pair.
type Readiness struct {
	request         port.HelperRequest
	entries         port.HelperRecoveryEntries
	revision, phase string
	recovery        port.HelperRecoveryPolicies
}

func expectedOperation(r port.HelperRequest) release.Operation {
	build := func(b port.HelperBuild) release.Build {
		return release.Build{Digest: b.Digest, Version: b.Version, BuildID: b.BuildID}
	}
	return release.Operation{ID: r.OperationID, Source: build(r.Source), Target: build(r.Target)}
}

// InspectInstallation completes application readiness using observation-only
// ports. It opens no route, acquires no lock, prepares no journal and consumes
// no mutation attempt. Native admission must independently precede Execute.
func InspectInstallation(ctx context.Context, request port.HelperRequest, observation port.HelperInstallationObservation, policies ...port.HelperRecoveryPolicies) (*Readiness, error) {
	if ctx == nil || observation == nil {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	r := captureRequest(request)
	var policy port.HelperRecoveryPolicies
	if len(policies) > 1 {
		return nil, &Failure{Code: "internal", Phase: "refused", Internal: true}
	}
	if len(policies) == 1 {
		policy = policies[0]
	}
	o := &operation{ctx: ctx, request: r, observation: observation, phase: "refused"}
	journal := func() (*port.JournalView, error) {
		var v *port.JournalView
		err := o.call(false, func() error { var err error; v, err = observation.ReadJournal(ctx); return err })
		if err != nil {
			return nil, err
		}
		if v == nil || v.Revision == "" {
			return nil, o.refuse("journal_invalid")
		}
		copy := *v
		if v.Value != nil {
			value := *v.Value
			copy.Value = &value
			if value.Operation != expectedOperation(r) {
				return nil, o.refuse("journal_mismatch")
			}
		}
		return &copy, nil
	}
	first, err := journal()
	if err != nil {
		return nil, err
	}
	e, err := o.entries()
	if err != nil {
		return nil, err
	}
	switch r.Action {
	case "apply":
		if first.Value != nil || e.Previous.Present || e.Failed.Present || e.RejectedTarget.Present {
			return nil, o.refuse("operation_exists")
		}
		if !owned(e.App) {
			return nil, o.refuse("app_missing")
		}
		if !owned(e.Staged) {
			return nil, o.refuse("staged_missing")
		}
		if err := o.verify(port.App, r.Source); err != nil {
			return nil, err
		}
		if err := o.verify(port.Staged, r.Target); err != nil {
			return nil, err
		}
		if e.App.Identity.Device != e.Staged.Identity.Device {
			return nil, o.refuse("exchange_unsupported")
		}
	case "rollback":
		if release.PredecessorStateUnqualified(r.Source.Version, r.Target.Version) {
			return nil, o.refuse("predecessor_state_unqualified")
		}
		if first.Value == nil {
			return nil, o.refuse("journal_invalid")
		}
		o.phase = first.Value.Phase
		switch o.phase {
		case "verified", "completed":
		case "launch_requested":
			// Original closed rollback refuses a launch whose outcome is unsettled.
			if r.Predecessor != nil {
				return nil, o.refuse("rollback_phase")
			}
		default:
			if r.Predecessor == nil {
				o.phase = "refused"
			}
			return nil, o.refuse("rollback_phase")
		}
		// Python closed_rollback_pair reports the observed phase ONLY for the
		// phase refusal above. Later pre-ACK pair/tree/journal refusals retain
		// their default refused phase; an observed verified journal is no success.
		o.phase = "refused"
		if !owned(e.App) || !owned(e.Previous) || e.Staged.Present || e.Failed.Present || e.RejectedTarget.Present {
			code := "rollback_pair"
			if r.Predecessor != nil {
				code = "closed_rollback_pair"
			}
			return nil, o.refuse(code)
		}
		if err := o.verify(port.App, r.Target); err != nil {
			return nil, err
		}
		if err := o.verify(port.Previous, r.Source); err != nil {
			return nil, err
		}
	case "recover":
		if first.Value == nil {
			return nil, o.refuse("journal_invalid")
		}
		o.phase = first.Value.Phase
		if r.Relaunch {
			if policy == nil {
				return nil, &Failure{Code: "recovery_policy_required", Phase: "refused", Internal: true}
			}
			recovery, err := policy.Observe(ctx, captureRequest(r), observation)
			if err != nil {
				return nil, err
			}
			if recovery == nil {
				return nil, &Failure{Code: "recovery_policy_required", Phase: "refused", Internal: true}
			}
			if err := recovery.Inspect(ctx); err != nil {
				return nil, err
			}
		}
	default:
		return nil, o.refuse("input")
	}
	after, err := o.entries()
	if err != nil {
		return nil, err
	}
	last, err := journal()
	if err != nil {
		return nil, err
	}
	if after != e {
		code := "readiness_pair_changed"
		if r.Action == "rollback" && r.Predecessor != nil {
			code = "closed_rollback_pair_changed"
		}
		return nil, o.refuse(code)
	}
	if first.Revision != last.Revision || !sameJournalValue(first.Value, last.Value) {
		code := "readiness_journal_changed"
		if r.Action == "rollback" && r.Predecessor != nil {
			code = "closed_rollback_journal_changed"
		}
		return nil, o.refuse(code)
	}
	if err := o.check(); err != nil {
		return nil, err
	}
	phase := ""
	if last.Value != nil {
		phase = last.Value.Phase
	}
	return &Readiness{request: r, entries: e, revision: last.Revision, phase: phase, recovery: policy}, nil
}

// Recheck repeats the actual observations after continuation/Quit under the
// real admission. Only closed rollback requires an identical pre-ACK journal
// revision and inode pair; a successful comparison grants no native authority.
func (r *Readiness) Recheck(ctx context.Context, observation port.HelperInstallationObservation) error {
	if r == nil {
		return &Failure{Code: "readiness_required", Phase: "refused"}
	}
	current, err := InspectInstallation(ctx, r.request, observation, r.recovery)
	if err != nil {
		return err
	}
	if r.request.Action == "rollback" && r.request.Predecessor != nil &&
		(r.entries != current.entries || r.revision != current.revision || r.phase != current.phase) {
		return &Failure{Code: "closed_rollback_pair_changed", Phase: "refused"}
	}
	return nil
}

func sameJournalValue(a, b *release.Journal) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
func sameHelperRequest(a, b port.HelperRequest) bool {
	if (a.InstallLocation == nil) != (b.InstallLocation == nil) || (a.Predecessor == nil) != (b.Predecessor == nil) || (a.LeaseIdentity == nil) != (b.LeaseIdentity == nil) {
		return false
	}
	if a.InstallLocation != nil && *a.InstallLocation != *b.InstallLocation || a.Predecessor != nil && *a.Predecessor != *b.Predecessor || a.LeaseIdentity != nil && *a.LeaseIdentity != *b.LeaseIdentity {
		return false
	}
	a.InstallLocation, b.InstallLocation = nil, nil
	a.Predecessor, b.Predecessor = nil, nil
	a.LeaseIdentity, b.LeaseIdentity = nil, nil
	return a == b
}
