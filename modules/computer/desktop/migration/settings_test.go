package migration

import (
	"context"
	"errors"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	delivery "github.com/legrch/farol/modules/computer/app/services/settingsdelivery"
	"github.com/legrch/farol/modules/computer/domain/journal"
	"github.com/legrch/farol/modules/computer/domain/observation"
)

func TestSettingsReaderMapsOnlyTheSelectedWorkspace(t *testing.T) {
	snapshot := delivery.Snapshot{Revision: 12, Current: delivery.Identity{
		ProfileID: "profile", OwnerID: "owner", ComputerID: "computer", Generation: 10,
	}}
	proof := wire.SettingsStoreContinuity{
		RootIdentity:      wire.ComputerContinuityRootIdentity{Device: "17", Inode: "50"},
		ConsentProjection: "serialized projection",
		Evidence: wire.SettingsStoreContinuityEvidence{
			Schema: "farol.workspace-continuity/1", ComputerId: "computer", WorkspaceId: "workspace",
			Root: "/Users/fixture", Filesystem: "apfs", VolumeUuid: "11111111-2222-3333-4444-555555555555",
			FileId: "50", BirthSeconds: "10", BirthNanoseconds: "7",
		},
	}
	load := SettingsReader(func(context.Context, string) (delivery.Snapshot, *wire.SettingsStoreContinuity, error) {
		return snapshot, &proof, nil
	})
	ctx := context.Background()
	read, err := load(ctx, "workspace")
	if err != nil || read.ProfileID != "profile" || read.OwnerID != "owner" || read.ComputerID != "computer" ||
		read.WorkspaceID != "workspace" || read.Root != "/Users/fixture" || read.Revision != 12 || read.Generation != 10 ||
		read.RootIdentity.Device != "17" || read.RootIdentity.Inode != "50" || read.Unsettled ||
		read.ConsentProjection != proof.ConsentProjection {
		t.Fatalf("incorrect Settings proof: %+v, %v", read, err)
	}
	if evidence, err := observation.ParseEvidence(read.Evidence); err != nil || evidence.FileID != "50" {
		t.Fatal("native tuple mapping", evidence, err)
	}
	if _, err := load(ctx, "other"); !errors.Is(err, journal.ErrRefused) {
		t.Fatal("crossed workspace accepted", err)
	}
	proof.Evidence.ComputerId = "other"
	if _, err := load(ctx, "workspace"); !errors.Is(err, journal.ErrRefused) {
		t.Fatal("crossed computer accepted", err)
	}
	proof.Evidence.ComputerId = "computer"
	snapshot.Pending = &delivery.Pending{}
	if read, err := load(ctx, "workspace"); err != nil || !read.Unsettled {
		t.Fatal("pending edit was lost", err)
	}
	snapshot.Pending = nil
	snapshot.VerificationInvalidated = true
	if read, err := load(ctx, "workspace"); err != nil || !read.Unsettled {
		t.Fatal("unknown verification was lost", err)
	}
}

func TestSettingsReaderPreservesUnknownExchange(t *testing.T) {
	for _, tc := range []struct{ from, want error }{
		{nil, journal.ErrRefused},
		{errors.New("unavailable before read"), journal.ErrRefused},
		{errors.Join(journal.ErrUnknown, errors.New("lost private reply")), journal.ErrUnknown},
	} {
		load := SettingsReader(func(context.Context, string) (delivery.Snapshot, *wire.SettingsStoreContinuity, error) {
			return delivery.Snapshot{}, nil, tc.from
		})
		if _, err := load(context.Background(), "workspace"); err != tc.want {
			t.Fatal("exchange outcome misclassified", err)
		}
	}
}
