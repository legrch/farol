package browse

import (
	"context"
	"slices"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func TestFilePolicySettingsListAndVerificationSnapshotPropagation(t *testing.T) {
	for _, mode := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		f := newFixture()
		f.approval.FilePolicy = mode
		f.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
		f.native.list = func(_ context.Context, r port.ListRequest) (*port.ListResponse, error) {
			if r.Workspace.FilePolicy != mode || !slices.Equal(r.Workspace.DeniedPaths, []string{"private"}) || r.Workspace.ExactFilePaths != nil {
				t.Fatalf("lost list policy: %+v", r.Workspace)
			}
			return &port.ListResponse{Binding: &port.DirectoryBinding{RelativePath: r.RelativePath, Root: r.Workspace.Root, ApprovedRoot: r.Workspace.ApprovedRoot}, Entries: []string{"file.txt"}}, nil
		}
		if _, err := f.service.List(context.Background(), request()); err != nil {
			t.Fatal(err)
		}
		snap := newSnapshotFixture()
		snap.approval.FilePolicy = mode
		snap.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/selected/private"}}
		snap.reader.read = func(_ context.Context, r port.ReadRequest) (*port.ReadResponse, error) {
			if r.Workspace.FilePolicy != mode || !slices.Equal(r.Workspace.DeniedPaths, []string{"selected/private"}) || r.Range != nil {
				t.Fatalf("lost verification policy: %+v", r.Workspace)
			}
			return snapshotOutput("hello", false), nil
		}
		if _, err := snap.service.Snapshot(context.Background(), snapshotRequest()); err != nil {
			t.Fatal(err)
		}
	}
}

func TestFilePolicySettingsTransitionRefusesDisclosure(t *testing.T) {
	f := newFixture()
	list := f.native.list
	f.native.list = func(ctx context.Context, r port.ListRequest) (*port.ListResponse, error) {
		f.approval.FilePolicy = authority.RootScopedFiles
		return list(ctx, r)
	}
	out, err := f.service.List(context.Background(), request())
	assertFailure(t, out, err, "AUTHORITY_COMPUTER_MISMATCH")
	if f.native.calls != 1 {
		t.Fatal("list repeated")
	}
	snap := newSnapshotFixture()
	snap.reader.read = func(context.Context, port.ReadRequest) (*port.ReadResponse, error) {
		snap.approval.FilePolicy = authority.RootScopedFiles
		return snapshotOutput("hello", false), nil
	}
	read, err := snap.service.Snapshot(context.Background(), snapshotRequest())
	snapshotFailure(t, read, err, "AUTHORITY_COMPUTER_MISMATCH")
	if snap.reader.calls != 1 {
		t.Fatal("verification repeated")
	}
}

func TestFilePolicySettingsUnknownRefusesBeforeIO(t *testing.T) {
	f := newFixture()
	f.approval.FilePolicy = "unknown"
	out, err := f.service.List(context.Background(), request())
	assertFailure(t, out, err, "COMPUTER_APPROVAL_INVALID")
	if f.native.calls != 0 {
		t.Fatal("unknown policy dispatched list")
	}
	snap := newSnapshotFixture()
	snap.approval.FilePolicy = "unknown"
	read, err := snap.service.Snapshot(context.Background(), snapshotRequest())
	snapshotFailure(t, read, err, "COMPUTER_APPROVAL_INVALID")
	if snap.reader.calls != 0 {
		t.Fatal("unknown policy dispatched verification")
	}
}
