package boot

import (
	"errors"
	"testing"
)

func TestCleanupCallbackErrorRequiresNoAdditionalOwnerFailure(t *testing.T) {
	native := errors.New("native refusal")
	owner := errors.New("owner close failed")
	if !onlyCleanupCallbackError(errors.Join(errors.Join(native, nil), nil), native) {
		t.Fatal("native refusal lost")
	}
	if onlyCleanupCallbackError(errors.Join(native, owner), native) || onlyCleanupCallbackError(owner, native) {
		t.Fatal("owner failure disguised as native refusal")
	}
}
