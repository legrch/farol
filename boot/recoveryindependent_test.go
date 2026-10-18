package boot

import (
	"errors"
	"fmt"
	"testing"

	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// Pure read-surface selection policy only, not a native Close-failure fixture.
func TestRecoveryComputerCleanupRequiresAnExplicitKnownReceipt(t *testing.T) {
	for _, state := range []accessrepo.ConstructorCleanupState{
		accessrepo.ConstructorCleanupUnreported,
		accessrepo.ConstructorCleanupNotAcquired,
		accessrepo.ConstructorCleanupConfirmed,
		accessrepo.ConstructorCleanupUnknown,
		255,
	} {
		for _, cleanupUnknown := range []bool{false, true} {
			for _, publicationUnknown := range []bool{false, true} {
				want := !cleanupUnknown && !publicationUnknown && (state == accessrepo.ConstructorCleanupNotAcquired || state == accessrepo.ConstructorCleanupConfirmed)
				if got := recoveryComputerCleanupKnown(state, cleanupUnknown, publicationUnknown); got != want {
					t.Fatalf("cleanup=%d cleanupUnknown=%t publicationUnknown=%t: %t", state, cleanupUnknown, publicationUnknown, got)
				}
			}
		}
	}
	for _, err := range []error{nil, errors.New("opaque constructor refusal"), &accessrepo.CommitFailure{Unknown: true}} {
		if recoveryComputerCleanupConfirmed(err) {
			t.Fatal("unreported constructor or publication uncertainty accepted")
		}
	}
	// Invalid binding is rejected before native IO, with the original owner's
	// explicit NotAcquired receipt. No receipt is manufactured by this test.
	store, err := accessrepo.Open("unused", accessrepo.Binding{}, accessrepo.Clock{})
	if store != nil || err == nil || accessrepo.ConstructorCleanup(err) != accessrepo.ConstructorCleanupNotAcquired {
		t.Fatal("original pre-native constructor contract changed")
	}
	if !recoveryComputerCleanupConfirmed(fmt.Errorf("constructor: %w", err)) {
		t.Fatal("original scoped receipt lost through wrapping")
	}
	if recoveryComputerCleanupConfirmed(errors.Join(err, &accessrepo.CommitFailure{Unknown: true})) {
		t.Fatal("known descriptor cleanup hid publication uncertainty")
	}
}
