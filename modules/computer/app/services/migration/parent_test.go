package migration

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/journal"
)

func TestOriginalParentRequiresOneCompletedSameModeEntry(t *testing.T) {
	ctx := context.Background()
	selection := intent()
	match := journal.StopEntry{
		Phase: journal.StopComplete,
		Request: journal.StopRequest{
			OperationID: "44444444-4444-4444-8444-444444444444", ChildOperationID: one,
			ChildMode: string(Legacy), HostLifetimeID: "lifetime", BackendGeneration: "backend",
			Root: selection.Request.Root, ProfileID: selection.Request.ProfileID,
			OwnerID: selection.Request.OwnerID, ComputerID: selection.Request.ComputerID,
			WorkspaceID: selection.Request.WorkspaceID, BootUUID: boot,
		},
		SettingsAck: &journal.StopSettingsReceipt{Revision: "9", ComputerGeneration: "7", ConsentDigest: goodDigest},
	}
	wrongMode := match
	wrongMode.Request.ChildMode = string(Rebind)
	pending := match
	pending.Phase = journal.StopCleanupAcknowledged
	stale := match
	stale.Request.HostLifetimeID = "prior-lifetime"
	second := match
	second.Request.OperationID = "55555555-5555-4555-8555-555555555555"
	cases := []struct {
		name    string
		entries []journal.StopEntry
		want    string
	}{
		{name: "none"},
		{name: "one", entries: []journal.StopEntry{match}, want: match.Request.OperationID},
		{name: "several", entries: []journal.StopEntry{match, second}},
		{name: "wrong mode", entries: []journal.StopEntry{wrongMode}},
		{name: "pending", entries: []journal.StopEntry{pending}},
		{name: "stale lifetime", entries: []journal.StopEntry{stale}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resolver := NewParent(func(context.Context) (journal.StopLedger, error) {
				return journal.StopLedger{Entries: tc.entries}, nil
			}, "lifetime", "backend")
			id, err := resolver.OriginalParent(ctx, selection)
			if id != tc.want || (tc.want == "" && !errors.Is(err, journal.ErrRefused)) || (tc.want != "" && err != nil) {
				t.Fatalf("resolve = %q, %v, want %q", id, err, tc.want)
			}
			if tc.want == "" {
				return
			}
			first, err := resolver.Select(ctx, one, Legacy, selection.Saved)
			if err != nil || first.Request.Root != match.Request.Root || first.Request.ExpectedRevision != "9" ||
				first.Request.ExpectedGeneration != "7" || first.Request.ConsentDigest != goodDigest ||
				first.Request.HostLifetimeID != "lifetime" || !journal.ValidRequest(first.Request) {
				t.Fatal("child request not derived from original prerequisite", first, err)
			}
			saved := selection.Saved
			saved.Binding.Device = "99"
			changed, err := resolver.Select(ctx, one, Legacy, saved)
			if err != nil || changed.Request.RequestDigest == first.Request.RequestDigest {
				t.Fatal("request digest failed to bind original saved binding", err)
			}
		})
	}
	resolver := NewParent(func(context.Context) (journal.StopLedger, error) {
		return journal.StopLedger{}, journal.ErrUnknown
	}, "lifetime", "backend")
	if _, err := resolver.OriginalParent(ctx, selection); !errors.Is(err, journal.ErrUnknown) {
		t.Fatal("parent custody uncertainty was lost", err)
	}
}
