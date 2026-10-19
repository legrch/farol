package egress

import (
	"strings"
	"testing"
)

func fixture() Intent {
	return Intent{Binding: Binding{OperationID: "operation", WorkspaceID: "workspace", RuntimeID: "runtime", GrantID: "grant", RepositoryID: "repository",
		SourceSeal: strings.Repeat("a", 64), DestinationSeal: strings.Repeat("b", 64)},
		Target: Target{Host: "github.com", Port: 22, User: "git", Repository: "owner/project.git"}, Format: "sha1",
		Ref: "refs/heads/feature/owner", BranchPrefix: "refs/heads/feature/", DefaultRef: "refs/heads/main",
		Base: strings.Repeat("a", 40), Head: strings.Repeat("b", 40), Old: strings.Repeat("0", 40),
		Objects: []Object{{OID: strings.Repeat("b", 40), Kind: "commit", Size: 100, Digest: strings.Repeat("c", 64)}},
		Known:   []Object{{OID: strings.Repeat("a", 40), Kind: "commit", Size: 100, Digest: strings.Repeat("d", 64)}}, Limits: DefaultLimits()}
}
func TestIntentCanonicalCopy(t *testing.T) {
	in := fixture()
	p, err := NewPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	original := p.Canonical()
	in.Objects[0].Digest = strings.Repeat("e", 64)
	in.Known[0].Size = 10
	copy := p.Intent()
	copy.Known[0].Kind = "blob"
	copy.Objects[0].Digest = "bad"
	p2, err := NewPlan(fixture())
	if err != nil {
		t.Fatal(err)
	}
	if p.Canonical() != original || p.Canonical() != p2.Canonical() {
		t.Fatal("mutable plan")
	}
	if got, _ := p.Object(fixture().Head); got.Digest != strings.Repeat("c", 64) {
		t.Fatal(got)
	}
	in = fixture()
	in.Objects = append(in.Objects, Object{OID: strings.Repeat("c", 40), Kind: "blob", Digest: strings.Repeat("e", 64), Size: 1})
	one, _ := NewPlan(in)
	in.Objects[0], in.Objects[1] = in.Objects[1], in.Objects[0]
	two, _ := NewPlan(in)
	if one.Canonical() != two.Canonical() {
		t.Fatal("ordering changes canonical encoding")
	}
}
func TestIntentEveryBoundaryChangesCanonical(t *testing.T) {
	base, _ := NewPlan(fixture())
	cases := []struct {
		name   string
		change func(*Intent)
	}{
		{"operation", func(i *Intent) { i.Binding.OperationID = "another" }},
		{"runtime", func(i *Intent) { i.Binding.RuntimeID = "another" }},
		{"workspace", func(i *Intent) { i.Binding.WorkspaceID = "another" }},
		{"grant", func(i *Intent) { i.Binding.GrantID = "another" }},
		{"repository identity", func(i *Intent) { i.Binding.RepositoryID = "another" }},
		{"source seal", func(i *Intent) { i.Binding.SourceSeal = strings.Repeat("f", 64) }},
		{"destination seal", func(i *Intent) { i.Binding.DestinationSeal = strings.Repeat("f", 64) }},
		{"host", func(i *Intent) { i.Target.Host = "example.com" }},
		{"port", func(i *Intent) { i.Target.Port = 443 }},
		{"user", func(i *Intent) { i.Target.User = "different" }},
		{"repository", func(i *Intent) { i.Target.Repository = "owner/other.git" }},
		{"ref", func(i *Intent) { i.Ref = "refs/heads/feature/other" }},
		{"old", func(i *Intent) { i.Old = i.Base }},
		{"limit", func(i *Intent) { i.Limits.PackBytes-- }},
		{"manifest", func(i *Intent) { i.Objects[0].Digest = strings.Repeat("f", 64) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := fixture()
			tc.change(&in)
			p, err := NewPlan(in)
			if err != nil {
				t.Fatal(err)
			}
			if p.Canonical() == base.Canonical() {
				t.Fatal("unsealed input")
			}
		})
	}
}
func TestIntentRefuses(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Intent)
	}{
		{"no owner binding", func(i *Intent) { i.Binding.GrantID = "" }},
		{"missing source", func(i *Intent) { i.Binding.SourceSeal = "" }},
		{"zero source seal", func(i *Intent) { i.Binding.SourceSeal = strings.Repeat("0", 64) }},
		{"zero destination seal", func(i *Intent) { i.Binding.DestinationSeal = strings.Repeat("0", 64) }},
		{"missing endpoint", func(i *Intent) { i.Binding.DestinationSeal = "" }},
		{"newline principal", func(i *Intent) { i.Binding.RepositoryID = "repo\nother" }},
		{"arbitrary URL", func(i *Intent) { i.Target.Host = "https://github.com" }},
		{"host alias", func(i *Intent) { i.Target.Host = "GitHub.COM" }},
		{"host option", func(i *Intent) { i.Target.Host = "-oProxyCommand" }},
		{"host empty label", func(i *Intent) { i.Target.Host = "github..com" }},
		{"port", func(i *Intent) { i.Target.Port = 0 }},
		{"SSH option", func(i *Intent) { i.Target.User = "-oProxyCommand" }},
		{"shell repository", func(i *Intent) { i.Target.Repository = "owner/repo';id;.git" }},
		{"repository traversal", func(i *Intent) { i.Target.Repository = "owner/../repo.git" }},
		{"repository absolute", func(i *Intent) { i.Target.Repository = "/owner/repo.git" }},
		{"repository option", func(i *Intent) { i.Target.Repository = "owner/-repo.git" }},
		{"repository expansion", func(i *Intent) { i.Target.Repository = "~owner/repo.git" }},
		{"delete", func(i *Intent) { i.Head = strings.Repeat("0", 40) }},
		{"implicit old", func(i *Intent) { i.Old = "" }},
		{"main", func(i *Intent) { i.Ref = i.DefaultRef }},
		{"tag", func(i *Intent) { i.Ref = "refs/tags/v1" }},
		{"foreign branch", func(i *Intent) { i.Ref = "refs/heads/other/foo" }},
		{"wildcard prefix", func(i *Intent) { i.BranchPrefix = "refs/heads/" }},
		{"unknown format", func(i *Intent) { i.Format = "sha512" }},
		{"short head", func(i *Intent) { i.Head = i.Head[:8] }},
		{"zero resource bound", func(i *Intent) { i.Limits.PackBytes = 0 }},
		{"unbounded objects", func(i *Intent) { i.Limits.Objects = 1 << 30 }},
		{"unbounded object bytes", func(i *Intent) { i.Limits.ObjectBytes = 1 << 40 }},
		{"unbounded expansion", func(i *Intent) { i.Limits.ExpandedBytes = 1 << 40 }},
		{"unbounded depth", func(i *Intent) { i.Limits.DeltaDepth = 1 << 20 }},
		{"missing head entry", func(i *Intent) { i.Objects = nil }},
		{"duplicate object", func(i *Intent) { i.Objects = append(i.Objects, i.Objects[0]) }},
		{"duplicate across manifests", func(i *Intent) { i.Known = append(i.Known, i.Objects[0]) }},
		{"bad strong hash", func(i *Intent) { i.Objects[0].Digest = "" }},
		{"tag payload", func(i *Intent) { i.Objects[0].Kind = "tag" }},
		{"negative object size", func(i *Intent) { i.Objects[0].Size = -1 }},
		{"unknown remote predecessor", func(i *Intent) { i.Old = strings.Repeat("f", 40) }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := fixture()
			tc.change(&in)
			if _, err := NewPlan(in); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}
func TestRefNames(t *testing.T) {
	for _, bad := range []string{"main", "HEAD", "refs/heads/.hidden", "refs/heads/x.lock", "refs/heads/x..y", "refs/heads/x@{0}", "refs/heads/a:b", "refs/heads/x/", "refs/heads/x\\y", "refs/heads/a?", "refs/heads/x\n", "refs/heads/-x", "refs/heads/x*", "refs/heads/x.", "refs/heads/x//y", "refs/heads/x\x7f", "refs/heads/é"} {
		if ValidRef(bad) {
			t.Errorf("accepted %q", bad)
		}
	}
	for _, good := range []string{"refs/heads/a", "refs/heads/feature/a-b.c_123", "refs/tags/v1.2.3"} {
		if !ValidRef(good) {
			t.Errorf("rejected %q", good)
		}
	}
}
func TestZeroPlan(t *testing.T) {
	var p *Plan
	if p.Canonical() != "" {
		t.Fatal("zero plan")
	}
	if _, ok := p.Object("x"); ok {
		t.Fatal("object")
	}
	if p.IsKnown("x") {
		t.Fatal("known")
	}
}
