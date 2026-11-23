//go:build !darwin

package stop

import (
	"context"
	"errors"
	"testing"
)

func TestUnsupportedPlatformNeverSignals(t *testing.T) {
	term, err := New(4242, "/Applications/Farol.app")
	if err != nil {
		t.Fatal(err)
	}
	if err := term.Signal(context.Background(), 1); !errors.Is(err, ErrUnknown) {
		t.Fatal(err)
	}
}
