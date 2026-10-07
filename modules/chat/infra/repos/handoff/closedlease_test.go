//go:build darwin || linux

package handoff

import (
	"context"
	"os"
	"testing"
)

func TestClosedLeaseNativeHandoffRetainsClaimCopyAndStickyFailure(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	roots, scope := closedInspectionNativeFixture(t)
	l, err := AcquireClosedInspection(context.Background(), roots, scope)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if other, err := AcquireClosedInspection(context.Background(), roots, scope); err == nil {
		other.Close()
		t.Fatal("handoff lease released claim")
	}
	v, err := l.Observation()
	if err != nil {
		t.Fatal(err)
	}
	v.Head.Record.Consumption.Next.BackendGeneration = "changed"
	*v.Head.Record.Terminal.ExitCode = 99
	v.Stages[0].Index = 99
	again, err := l.Observation()
	if err != nil || again.Head.Record.Consumption.Next != scope || *again.Head.Record.Terminal.ExitCode != 0 || again.Stages[0].Index != 1 {
		t.Fatal("handoff metadata aliases owner", err)
	}
	archive := roots.Chat.Path + ".disposable-archive"
	if err := os.Rename(roots.Chat.Path, archive); err != nil {
		t.Fatal(err)
	}
	if err := l.Verify(); err == nil {
		t.Fatal("relocated handoff qualified original name")
	}
	if err := os.Rename(archive, roots.Chat.Path); err != nil {
		t.Fatal(err)
	}
	if err := l.Verify(); err == nil {
		t.Fatal("restored name erased failed observation")
	}
	if _, err := l.Observation(); err == nil {
		t.Fatal("failed handoff lease exposed metadata")
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	next, err := AcquireClosedInspection(context.Background(), roots, scope)
	if err != nil {
		t.Fatal("handoff claim leaked", err)
	}
	next.Close()
}
