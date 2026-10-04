package access

import (
	"context"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Native storage only, with disposable roots. No child, app or provider.
func TestNativeOwnerApprovalUsesSoleStoreWithoutParticipants(t *testing.T) {
	f := fixtureState(t)
	ctx := context.Background()
	if err := f.store.WithOwnerApproval(ctx, func(s Status, a *authority.Approval) error {
		if s.Revision != 0 || s.ApprovalPresent || a != nil {
			t.Fatal("empty owner invented approval")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	approve(t, f)
	before := status(t, f.store)
	for i := 0; i < 2; i++ {
		if err := f.store.WithOwnerApproval(ctx, func(s Status, a *authority.Approval) error {
			if s != before || a == nil || !authority.SameApprovalPolicy(*a, f.approval) {
				t.Fatal("wrong sole-owner snapshot")
			}
			a.Workspaces[0].Root = "/mutated-copy"
			a.Capabilities[0] = authority.Shell
			return nil
		}); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.store.current.Participants) != 0 || status(t, f.store) != before {
		t.Fatal("owner inspection mutated authority")
	}
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	called := false
	if err := f.store.WithOwnerApproval(ctx, func(Status, *authority.Approval) error { called = true; return nil }); err == nil || called {
		t.Fatal("closed store disclosed authority")
	}
}
