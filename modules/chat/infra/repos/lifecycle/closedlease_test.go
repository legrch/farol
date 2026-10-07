//go:build darwin || linux

package lifecycle

import (
	"context"
	"os"
	"testing"
)

func TestClosedLeaseNativeLifecycleRetainsClaimAndStickyFailure(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	root, _ := nativeInspectionFixture(t, inspectionEmptyRecord())
	l, err := AcquireClosedInspection(context.Background(), root, scope, inspectionLimits)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if other, err := AcquireClosedInspection(context.Background(), root, scope, inspectionLimits); err == nil {
		other.Close()
		t.Fatal("retained lease released claim")
	}
	v, err := l.Observation()
	if err != nil {
		t.Fatal(err)
	}
	v.Incarnations[0] = "changed"
	again, err := l.Observation()
	if err != nil || again.Incarnations[0] != scope.BackendGeneration {
		t.Fatal("observation leaked mutable state", err)
	}
	archive := root.Path + ".disposable-archive"
	if err := os.Rename(root.Path, archive); err != nil {
		t.Fatal(err)
	}
	if err := l.Verify(); err == nil {
		t.Fatal("old canonical pathname remained qualified")
	}
	if err := os.Rename(archive, root.Path); err != nil {
		t.Fatal(err)
	}
	if err := l.Verify(); err == nil {
		t.Fatal("restored path erased refused observation")
	}
	if _, err := l.Observation(); err == nil {
		t.Fatal("failed lease exposed usable metadata")
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if err := l.Close(); err != nil {
		t.Fatal("Close retried descriptors", err)
	}
	next, err := AcquireClosedInspection(context.Background(), root, scope, inspectionLimits)
	if err != nil {
		t.Fatal("original descriptors not closed", err)
	}
	next.Close()
}
