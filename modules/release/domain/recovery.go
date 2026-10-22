package release

// Build is measured accepted bundle identity, never a version-label-only claim.
type Build struct {
	Digest  string
	Version string
	BuildID string
}

type Operation struct {
	ID     string
	Source Build
	Target Build
}

type Journal struct {
	Operation Operation
	Phase     string
	Note      string
}

type Helper struct {
	PID          int64
	ProcessStart string // empty means unavailable, not invented or wildcard
}

type ProcessState uint8

const (
	ProcessUnknown ProcessState = iota
	ProcessAbsent
	ProcessPresent
)

type ProcessObservation struct {
	PID          int64
	State        ProcessState
	ProcessStart string
}

// HelperEnded requires a bound recorded PID and an exact fresh observation.
// A missing PID, unknown readback or a present PID with no original start time
// does not prove the original child exited. A confirmed different start proves
// PID reuse only when the original start was available.
func HelperEnded(helper *Helper, observed ProcessObservation) bool {
	if helper == nil || helper.PID < 2 || helper.PID != observed.PID {
		return false
	}
	if observed.State == ProcessAbsent {
		return true
	}
	return observed.State == ProcessPresent && helper.ProcessStart != "" && observed.ProcessStart != "" && helper.ProcessStart != observed.ProcessStart
}

type RecoveryKind uint8

const (
	Unresolved RecoveryKind = iota
	ReconcilePreparation
	ExplicitRecovery
	// RollbackAvailable observes a settled target and measured predecessor.
	// It does not prove helper exit or authorize restoration dispatch.
	RollbackAvailable
	SettledSource
)

type LaunchState uint8

const (
	NoLaunch LaunchState = iota
	LaunchUnknown
	LaunchReturned
)

// Assessment describes retained state only. Every explicit restoration still
// requires the native runtime to acquire admission and verify its durable intent.
type Assessment struct {
	Kind   RecoveryKind
	Code   string
	Launch LaunchState
}

// Observation contains one coherent, physically verified directory snapshot.
// Complete=false includes denied/changing/unreadable paths; nil then proves no
// absence. HelperExited must come from HelperEnded or same-child terminal proof.
// Assess is observational only and never returns a dispatch/relaunch command.
type Observation struct {
	Operation       Operation
	Journal         *Journal
	Complete        bool
	Slot            *Build
	Staged          *Build
	Previous        *Build
	Failed          *Build
	HelperExited    bool
	ArchiveVerified bool
	RestorePending  bool
}

func validHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func validBuild(b Build) bool {
	return b.Version != "" && len(b.Version) <= 128 && validHex(b.Digest, 64) && validHex(b.BuildID, 64)
}
func same(b *Build, expected Build) bool { return b != nil && *b == expected }

func Assess(o Observation) Assessment {
	blocked := func(code string) Assessment { return Assessment{Code: code} }
	op := o.Operation
	if !validHex(op.ID, 32) || !validBuild(op.Source) || !validBuild(op.Target) || op.Source == op.Target {
		return blocked("UPDATE_OPERATION_IDENTITY_MISMATCH")
	}
	if !o.Complete {
		return blocked("UPDATE_RECOVERY_OBSERVATION_UNKNOWN")
	}
	if o.RestorePending {
		return blocked("UPDATE_RESTORE_OUTCOME_UNKNOWN")
	}
	if o.Journal == nil {
		if !o.HelperExited {
			return blocked("UPDATE_HELPER_EXIT_UNCONFIRMED")
		}
		if !same(o.Slot, op.Source) || !same(o.Staged, op.Target) || o.Previous != nil || o.Failed != nil {
			return blocked("UPDATE_RECOVERY_IDENTITY_MISMATCH")
		}
		if !o.ArchiveVerified {
			return blocked("UPDATE_RETAINED_PACKAGE_INVALID")
		}
		// Native reconciliation still must record the pre-mutation exit, durably
		// enter preparation cleanup and confirm cleanup before exposing Ready.
		return Assessment{Kind: ReconcilePreparation}
	}
	if o.Journal.Operation != op {
		return blocked("UPDATE_OPERATION_IDENTITY_MISMATCH")
	}
	phase := o.Journal.Phase
	launch := NoLaunch
	switch phase {
	case "prepared", "predecessor_saved", "new_installed", "verified", "rollback_started", "rolled_back", "cancelled":
	case "launch_requested", "cancel_launch_requested", "rollback_launch_requested":
		launch = LaunchUnknown
	case "completed", "cancel_completed", "rollback_completed":
		launch = LaunchReturned
	default:
		return blocked("UPDATE_JOURNAL_INVALID")
	}
	result := func(kind RecoveryKind) Assessment { return Assessment{Kind: kind, Launch: launch} }
	targetPrevious := same(o.Slot, op.Target) && o.Staged == nil && same(o.Previous, op.Source) && o.Failed == nil
	sourceStaged := same(o.Slot, op.Source) && same(o.Staged, op.Target) && o.Previous == nil && o.Failed == nil
	sourceFailed := same(o.Slot, op.Source) && o.Staged == nil && o.Previous == nil && same(o.Failed, op.Target)
	switch phase {
	case "verified", "launch_requested", "completed":
		// Preserve the accepted runtime's settled-pair observation independently
		// of original-helper exit. Interrupted pairs below require exit proof.
		// Neither assessment bypasses native restoration admission.
		if targetPrevious {
			return result(RollbackAvailable)
		}
	case "cancelled", "cancel_launch_requested", "cancel_completed":
		if sourceStaged {
			return result(SettledSource)
		}
	case "rolled_back", "rollback_launch_requested", "rollback_completed":
		if sourceFailed {
			return result(SettledSource)
		}
	case "prepared", "predecessor_saved", "new_installed", "rollback_started":
		if !o.HelperExited {
			return blocked("UPDATE_HELPER_EXIT_UNCONFIRMED")
		}
		eligible := targetPrevious
		if phase == "prepared" {
			eligible = eligible || sourceStaged || (same(o.Slot, op.Target) && same(o.Staged, op.Source) && o.Previous == nil && o.Failed == nil)
		}
		if phase == "prepared" || phase == "predecessor_saved" {
			// Exact old two-rename gap; the new exchange path never creates it.
			eligible = eligible || (o.Slot == nil && same(o.Staged, op.Target) && same(o.Previous, op.Source) && o.Failed == nil)
		}
		if phase == "rollback_started" {
			eligible = eligible || sourceFailed || (same(o.Slot, op.Source) && o.Staged == nil && same(o.Previous, op.Target) && o.Failed == nil)
		}
		if eligible {
			return result(ExplicitRecovery)
		}
	}
	return blocked("UPDATE_RECOVERY_IDENTITY_MISMATCH")
}
