package mutation

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Pure app snapshots and port doubles; no actual mutation or filesystem IO.
func TestFilePolicyMutationDescriptorPreservesTaskRestrictions(t *testing.T) {
	for _, mode := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		f := newExecutionFixture(t)
		f.lease.a.FilePolicy, f.lease.p.Grant.FilePolicy = mode, mode
		f.lease.p.Grant.Workspaces[0].Mode = authority.Exact
		f.lease.p.Grant.Workspaces[0].Paths = []string{"/work/note.md"}
		f.lease.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
		f.lease.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/cache"}}
		f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
			d := r.Workspace
			if d.FilePolicy != mode || d.Root != "/work" || d.ApprovedRoot != (port.Root{Path: "/work", Device: "7", Inode: "2"}) || !slices.Equal(d.DeniedPaths, []string{"private", "cache"}) {
				t.Fatalf("lost task descriptor policy: %+v", d)
			}
			if err := r.BeforePublish(ctx); err != nil {
				return nil, err
			}
			return &port.MutationReceipt{Operation: "write", RelativePath: r.Operation.Path(), Bytes: 3, AfterSHA256: strings.Repeat("c", 64)}, nil
		}
		if out, err := f.service.Execute(context.Background(), f.request); err != nil || out.Phase != "completed" {
			t.Fatalf("%+v %v", out, err)
		}
		if _, err := f.service.current(context.Background(), "work", "other.md", nil, nil); err == nil {
			t.Fatal("exact mutation scope widened")
		}
	}
}

func TestFilePolicyMutationRefusesIncoherentSnapshotBeforeAdmission(t *testing.T) {
	for _, modes := range [][2]authority.FilePolicy{{authority.LegacyProtectedFiles, authority.RootScopedFiles}, {authority.RootScopedFiles, authority.LegacyProtectedFiles}, {"unknown", "unknown"}} {
		f := newExecutionFixture(t)
		f.lease.p.Grant.FilePolicy, f.lease.a.FilePolicy = modes[0], modes[1]
		if out, err := f.service.Execute(context.Background(), f.request); out != nil || err == nil || f.store.admissions != 0 || f.native.calls != 0 {
			t.Fatal("incoherent mutation selection admitted")
		}
	}
}

func TestFilePolicyMutationModeTransitionRefusesOldPublication(t *testing.T) {
	for _, both := range []bool{false, true} {
		f := newExecutionFixture(t)
		f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
			f.lease.a.FilePolicy = authority.RootScopedFiles
			if both {
				f.lease.p.Grant.FilePolicy = authority.RootScopedFiles
			}
			err := r.BeforePublish(ctx)
			requireCode(t, err, "AUTHORITY_COMPUTER_MISMATCH")
			return nil, err
		}
		_, err := f.service.Execute(context.Background(), f.request)
		if both {
			// The port double changes both current values. The descriptor seal still
			// refuses publication; a real selected lease also seals the policy ceiling.
			if err != nil {
				t.Fatal(err)
			}
		} else {
			requireCode(t, err, "AUTHORITY_COMPUTER_MISMATCH")
		}
		if f.native.calls != 1 || f.store.record.Phase() != state.Failed {
			t.Fatal("old mutation published or repeated")
		}
	}
}

func TestFilePolicyOwnerMutationDescriptorAndSeal(t *testing.T) {
	f := newOwnerFixture(t)
	f.source.approval.FilePolicy = authority.RootScopedFiles
	f.source.approval.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
	f.service = f.restart(t)
	f.native.run = func(ctx context.Context, r port.MutationRequest) (*port.MutationReceipt, error) {
		if r.Workspace.FilePolicy != authority.RootScopedFiles || !slices.Equal(r.Workspace.DeniedPaths, []string{"private"}) {
			t.Fatalf("lost owner policy: %+v", r.Workspace)
		}
		f.source.approval.FilePolicy = authority.LegacyProtectedFiles
		err := r.BeforePublish(ctx)
		requireCode(t, err, "AUTHORITY_COMPUTER_MISMATCH")
		return nil, err
	}
	_, err := f.service.Execute(context.Background(), f.request)
	requireCode(t, err, "AUTHORITY_COMPUTER_MISMATCH")
	if f.native.calls != 1 || f.store.record.Phase() != state.Failed {
		t.Fatal("owner policy change admitted old effect")
	}
}
