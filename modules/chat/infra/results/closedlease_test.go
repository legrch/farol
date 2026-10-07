//go:build darwin || linux

package results

import (
	"context"
	"os"
	"testing"
)

func TestClosedLeaseNativeResultsRetainsClaimAndStickyFailure(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	root, scope := closedInspectionNativeFixture(t)
	l, err := AcquireClosedInspection(context.Background(), root, scope)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if other, err := AcquireClosedInspection(context.Background(), root, scope); err == nil {
		other.Close()
		t.Fatal("retained result lease released claim")
	}
	archive := root.Path + ".disposable-archive"
	if err := os.Rename(root.Path, archive); err != nil {
		t.Fatal(err)
	}
	if err := l.Verify(); err == nil {
		t.Fatal("relocated result root remained qualified")
	}
	if err := os.Rename(archive, root.Path); err != nil {
		t.Fatal(err)
	}
	if err := l.Verify(); err == nil {
		t.Fatal("restored path erased failed observation")
	}
	if _, err := l.Observation(); err == nil {
		t.Fatal("failed lease returned usable result projection")
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := AcquireClosedInspection(context.Background(), root, scope)
	if err != nil {
		t.Fatal("result claim leaked", err)
	}
	next.Close()
}
