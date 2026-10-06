package workspace

import (
	"context"
	"slices"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

func TestFilePolicyReadDescriptorPreservesExactScopeAndRestrictions(t *testing.T) {
	for _, mode := range []authority.FilePolicy{authority.LegacyProtectedFiles, authority.RootScopedFiles} {
		s, p, a, n, _, r := fixture(t)
		p.p.Grant.FilePolicy, a.a.FilePolicy = mode, mode
		p.p.Grant.Workspaces[0].Mode = authority.Exact
		p.p.Grant.Workspaces[0].Paths = []string{"/work/readme"}
		p.p.Grant.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private", RestrictionSource: authority.OwnerRestrictionSource}}
		a.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/cache"}}
		if _, err := s.Read(context.Background(), r); err != nil {
			t.Fatal(err)
		}
		d := n.readRequest.Workspace
		if d.FilePolicy != mode || !slices.Equal(d.ExactFilePaths, []string{"readme"}) || !slices.Equal(d.DeniedPaths, []string{"private", "cache"}) || d.ApprovedRoot.Path != "/work" {
			t.Fatalf("lost policy/restrictions: %+v", d)
		}
		r.RelativePath = "other"
		if _, err := s.Read(context.Background(), r); err == nil || n.reads != 1 {
			t.Fatal("exact scope widened")
		}
	}
}

func TestFilePolicyListDescriptorPreservesRestrictions(t *testing.T) {
	s, p, a, n, _, r := fixture(t)
	p.p.Grant.FilePolicy, a.a.FilePolicy = authority.RootScopedFiles, authority.RootScopedFiles
	a.a.ExcludedPaths = []authority.Exclusion{{WorkspaceID: "work", Path: "/work/private"}}
	if _, err := s.List(context.Background(), listRequest(r)); err != nil {
		t.Fatal(err)
	}
	d := n.listRequest.Workspace
	if d.FilePolicy != authority.RootScopedFiles || d.ExactFilePaths != nil || !slices.Equal(d.DeniedPaths, []string{"private"}) {
		t.Fatalf("lost list policy: %+v", d)
	}
}

func TestFilePolicyReadRefusesIncoherentOrUnknownSelection(t *testing.T) {
	for _, modes := range [][2]authority.FilePolicy{{authority.LegacyProtectedFiles, authority.RootScopedFiles}, {authority.RootScopedFiles, authority.LegacyProtectedFiles}, {"unknown", "unknown"}} {
		s, p, a, n, _, r := fixture(t)
		p.p.Grant.FilePolicy, a.a.FilePolicy = modes[0], modes[1]
		if out, err := s.Read(context.Background(), r); err == nil || out != nil || n.reads != 0 {
			t.Fatal("incoherent selection reached native")
		}
	}
}

func TestFilePolicyReadModeChangeDuringIOCannotDisclose(t *testing.T) {
	for _, both := range []bool{false, true} {
		s, p, a, n, _, r := fixture(t)
		n.hook = func() {
			a.a.FilePolicy = authority.RootScopedFiles
			if both {
				p.p.Grant.FilePolicy = authority.RootScopedFiles
			}
		}
		out, err := s.Read(context.Background(), r)
		if out != nil || n.reads != 1 {
			t.Fatal("disclosed or retried old read")
		}
		expectFailure(t, err, "AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	}
}
