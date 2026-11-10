//go:build !darwin

package observation

import (
	"context"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
	"testing"
)

func TestUnsupportedPlatformNeverFallsBackToInode(t *testing.T) {
	got, err := New().Observe(context.Background(), "/does/not/exist")
	if code(err) != "WORKSPACE_IDENTITY_UNSUPPORTED" || got != (identity.Observation{}) {
		t.Fatalf("%v %v", got, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := New().Observe(ctx, "/does/not/exist"); code(err) != "WORKSPACE_REQUEST_CANCELLED" {
		t.Fatal(err)
	}
}
