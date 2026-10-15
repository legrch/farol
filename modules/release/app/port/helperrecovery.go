package port

import "context"

// HelperRecoveryEntry names only existing fixed entries, never caller paths.
type HelperRecoveryEntry uint8

const (
	App HelperRecoveryEntry = iota
	Staged
	Previous
	Failed
	RejectedTarget
)

type HelperRecoveryEntrySnapshot struct {
	Present, Directory, OwnedByEffectiveUser bool
	Identity                                 HelperIdentity
}

// HelperRecoveryEntries is one complete coherent nofollow observation of all
// five fixed names. Present=false proves absence, never an unreadable entry.
type HelperRecoveryEntries struct {
	App, Staged, Previous, Failed, RejectedTarget HelperRecoveryEntrySnapshot
}

// HelperRecoveryFailure classifies an original helper refusal or a retained
// native/internal outcome. Cause preserves dependency provenance without putting
// private paths, bytes or syscall messages into Error's safe closed text.
type HelperRecoveryFailure struct {
	Code, Phase         string
	Internal, Uncertain bool
	Cause               error
}

func (*HelperRecoveryFailure) Error() string   { return "helper_recovery_failure" }
func (f *HelperRecoveryFailure) Unwrap() error { return f.Cause }

// HelperRecoveryRuntime borrows real serialized route/lease/slot/admission
// custody for one immutable parsed request. The caller retains custody until
// actual native return, including cancellation. No method retries, cleans up,
// relaunches or substitutes a context/deadline. Unknown effects remain retained
// by the existing owner across calls and adapters; this is no second journal.
// Native methods independently enforce the original absolute budget, including
// an earlier context deadline even if context.Err's timer notification lags.
type HelperRecoveryRuntime interface {
	// ReadPhase validates the same operation journal and slot binding.
	ReadPhase(context.Context) (string, error)
	Entries(context.Context) (HelperRecoveryEntries, error)
	// MatchesTree returns false only for an original verification Refusal.
	// Internal, syscall, cleanup and cancellation failures remain errors.
	MatchesTree(context.Context, HelperRecoveryEntry, HelperBuild) (bool, error)
	// VerifyTree performs complete digest plus plist/build verification.
	VerifyTree(context.Context, HelperRecoveryEntry, HelperBuild) error
	Fence(context.Context) error
	Rename(context.Context, HelperRecoveryEntry, HelperRecoveryEntry, HelperIdentity) error
	Exchange(context.Context, HelperRecoveryEntry, HelperRecoveryEntry, HelperIdentity, HelperIdentity) error
	// WritePhase durably writes the same journal through its existing owner.
	WritePhase(context.Context, string) error
}
