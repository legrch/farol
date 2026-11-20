package migration

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/journal"
)

func TestRuntimeCloseDoesNotCertifyOriginalTransition(t *testing.T) {
	owner, store, native := makeOwner(true)
	ctx := context.Background()
	if _, err := owner.Begin(ctx, intent()); err != nil {
		t.Fatal(err)
	}
	native.closeError = true
	first := owner.Close()
	if first == nil {
		t.Fatal("missing native close error")
	}
	if err := owner.Close(); err != first || native.closes != 2 || !store.journal.Unresolved() {
		t.Fatal("retirement replayed cleanup or fabricated a certificate", err)
	}
	if _, err := owner.Confirm(ctx, one, "/Users/test", true); !errors.Is(err, journal.ErrRefused) {
		t.Fatal("retired owner admitted a confirmation", err)
	}
}
