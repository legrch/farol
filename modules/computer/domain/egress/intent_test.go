package egress

import (
	"errors"
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

func fixture256() Intent {
	in := fixture()
	in.Format = "sha256"
	in.Base, in.Head, in.Old = strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("0", 64)
	in.Objects = []Object{{OID: in.Head, Kind: "commit", Size: 100, Digest: strings.Repeat("c", 64)}}
	in.Known = []Object{{OID: in.Base, Kind: "commit", Size: 100, Digest: strings.Repeat("d", 64)}}
	return in
}

func TestPlanAcceptsBothObjectFormats(t *testing.T) {
	for name, in := range map[string]Intent{"sha1": fixture(), "sha256": fixture256()} {
		t.Run(name, func(t *testing.T) {
			p, err := NewPlan(in)
			if err != nil {
				t.Fatal(err)
			}
			want := map[string]int{"sha1": 20, "sha256": 32}[name]
			if p.OIDBytes() != want {
				t.Fatal(p.OIDBytes())
			}
			if !p.IsKnown(in.Base) || p.IsKnown(in.Head) || p.IsKnown(strings.Repeat("9", len(in.Head))) {
				t.Fatal("known set")
			}
			if o, ok := p.Object(in.Head); !ok || o.Kind != "commit" {
				t.Fatal(o, ok)
			}
			if o, ok := p.Object(in.Base); !ok || o.Digest != strings.Repeat("d", 64) {
				t.Fatal(o, ok)
			}
			if _, ok := p.Object(strings.Repeat("9", len(in.Head))); ok {
				t.Fatal("unlisted object")
			}
		})
	}
}

func TestPlanRefusesMixedAndMalformedIdentities(t *testing.T) {
	cases := map[string]func(*Intent){
		"sha1 intent with sha256 head":  func(i *Intent) { i.Head = strings.Repeat("b", 64) },
		"sha1 intent with sha256 old":   func(i *Intent) { i.Old = strings.Repeat("0", 64) },
		"sha1 manifest with sha256 oid": func(i *Intent) { i.Objects[0].OID = strings.Repeat("b", 64) },
		"uppercase object id":           func(i *Intent) { i.Head = strings.Repeat("B", 40); i.Objects[0].OID = i.Head },
		"base is not hex":               func(i *Intent) { i.Base = strings.Repeat("g", 40) },
		"zero base":                     func(i *Intent) { i.Base = strings.Repeat("0", 40) },
		"base missing from manifests":   func(i *Intent) { i.Base = strings.Repeat("e", 40) },
		"base is not a commit":          func(i *Intent) { i.Known[0].Kind = "blob" },
		"head is not a commit":          func(i *Intent) { i.Objects[0].Kind = "tree" },
		"predecessor is not a commit":   func(i *Intent) { i.Old = i.Base; i.Known[0].Kind = "tree" },
		"zero manifest oid": func(i *Intent) {
			i.Objects = append(i.Objects, Object{OID: strings.Repeat("0", 40), Kind: "blob", Digest: strings.Repeat("e", 64)})
		},
		"manifest digest uppercase":      func(i *Intent) { i.Objects[0].Digest = strings.Repeat("C", 64) },
		"manifest digest too short":      func(i *Intent) { i.Objects[0].Digest = strings.Repeat("c", 63) },
		"manifest digest too long":       func(i *Intent) { i.Objects[0].Digest = strings.Repeat("c", 65) },
		"manifest digest not hex":        func(i *Intent) { i.Objects[0].Digest = strings.Repeat("z", 64) },
		"unknown manifest kind":          func(i *Intent) { i.Known[0].Kind = "" },
		"manifest object over the bound": func(i *Intent) { i.Objects[0].Size = i.Limits.ObjectBytes + 1 },
		"duplicate within known":         func(i *Intent) { i.Known = append(i.Known, i.Known[0]) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			in := fixture()
			change(&in)
			if _, err := NewPlan(in); !errors.Is(err, ErrIntent) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

func TestPlanAcceptsAPredecessorFromEitherManifest(t *testing.T) {
	in := fixture()
	in.Old = in.Base // known
	if _, err := NewPlan(in); err != nil {
		t.Fatal(err)
	}
	in = fixture()
	in.Old = in.Head // introduced
	if _, err := NewPlan(in); err != nil {
		t.Fatal(err)
	}
}

func TestManifestSizeBoundIsInclusive(t *testing.T) {
	in := fixture()
	in.Objects[0].Size = in.Limits.ObjectBytes
	if _, err := NewPlan(in); err != nil {
		t.Fatal(err)
	}
	in.Objects[0].Size++
	if _, err := NewPlan(in); err == nil {
		t.Fatal("accepted")
	}
}

func TestObjectCountBoundCoversBothManifestsTogether(t *testing.T) {
	for _, tc := range []struct {
		objects int
		ok      bool
	}{{2, true}, {1, false}} {
		in := fixture()
		in.Limits.Objects = tc.objects
		if _, err := NewPlan(in); (err == nil) != tc.ok {
			t.Fatalf("limit %d: %v", tc.objects, err)
		}
	}
	// A bound of one holds a single manifest entry but not two.
	in := fixture()
	in.Limits.Objects = 1
	in.Known = nil
	in.Base = in.Head
	if _, err := NewPlan(in); err != nil {
		t.Fatal(err)
	}
	in.Objects = append(in.Objects, Object{OID: strings.Repeat("e", 40), Kind: "blob", Digest: strings.Repeat("e", 64)})
	if _, err := NewPlan(in); err == nil {
		t.Fatal("two objects accepted under a bound of one")
	}
	// Known alone may not exceed the bound either.
	in = fixture()
	in.Limits.Objects = 1
	in.Objects = nil
	in.Head = in.Base
	if _, err := NewPlan(in); err != nil {
		t.Fatal(err)
	}
	in.Known = append(in.Known, Object{OID: strings.Repeat("e", 40), Kind: "blob", Digest: strings.Repeat("e", 64)})
	if _, err := NewPlan(in); err == nil {
		t.Fatal("two known objects accepted under a bound of one")
	}
}

func TestLimitBoundariesAreInclusive(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Limits)
		ok     bool
	}{
		{"pack bytes minimum", func(l *Limits) { l.PackBytes = 32 }, true},
		{"pack bytes below minimum", func(l *Limits) { l.PackBytes = 31 }, false},
		{"pack bytes maximum", func(l *Limits) { l.PackBytes = 64 << 20 }, true},
		{"pack bytes above maximum", func(l *Limits) { l.PackBytes = 64<<20 + 1 }, false},
		{"negative pack bytes", func(l *Limits) { l.PackBytes = -1 }, false},
		{"expanded bytes zero", func(l *Limits) { l.ExpandedBytes = 0 }, false},
		{"expanded bytes maximum", func(l *Limits) { l.ExpandedBytes = 128 << 20 }, true},
		{"expanded bytes above maximum", func(l *Limits) { l.ExpandedBytes = 128<<20 + 1 }, false},
		{"expanded equal to object bound", func(l *Limits) { l.ExpandedBytes = l.ObjectBytes }, true},
		{"expanded below object bound", func(l *Limits) { l.ExpandedBytes = l.ObjectBytes - 1 }, false},
		{"object bytes zero", func(l *Limits) { l.ObjectBytes = 0 }, false},
		{"object bytes maximum", func(l *Limits) { l.ObjectBytes = 16 << 20 }, true},
		{"object bytes above maximum", func(l *Limits) { l.ObjectBytes = 16<<20 + 1 }, false},
		{"objects zero", func(l *Limits) { l.Objects = 0 }, false},
		{"objects maximum", func(l *Limits) { l.Objects = 65536 }, true},
		{"objects above maximum", func(l *Limits) { l.Objects = 65537 }, false},
		{"delta depth zero", func(l *Limits) { l.DeltaDepth = 0 }, false},
		{"delta depth one", func(l *Limits) { l.DeltaDepth = 1 }, true},
		{"delta depth maximum", func(l *Limits) { l.DeltaDepth = 64 }, true},
		{"delta depth above maximum", func(l *Limits) { l.DeltaDepth = 65 }, false},
		{"advertisement below minimum", func(l *Limits) { l.AdvertisementBytes = 63 }, false},
		{"advertisement minimum", func(l *Limits) { l.AdvertisementBytes = 64 }, true},
		{"advertisement maximum", func(l *Limits) { l.AdvertisementBytes = 4 << 20 }, true},
		{"advertisement above maximum", func(l *Limits) { l.AdvertisementBytes = 4<<20 + 1 }, false},
		{"ref count zero", func(l *Limits) { l.RefCount = 0 }, false},
		{"ref count one", func(l *Limits) { l.RefCount = 1 }, true},
		{"ref count maximum", func(l *Limits) { l.RefCount = 65536 }, true},
		{"ref count above maximum", func(l *Limits) { l.RefCount = 65537 }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := fixture()
			tc.change(&in.Limits)
			if _, err := NewPlan(in); (err == nil) != tc.ok {
				t.Fatalf("ok=%v, err=%v", tc.ok, err)
			}
		})
	}
}

func TestRefAndBranchScopeRefusals(t *testing.T) {
	cases := map[string]func(*Intent){
		"default ref outside heads":      func(i *Intent) { i.DefaultRef = "refs/tags/main" },
		"invalid default ref":            func(i *Intent) { i.DefaultRef = "refs/heads/a..b" },
		"prefix without trailing slash":  func(i *Intent) { i.BranchPrefix = "refs/heads/feature" },
		"prefix outside heads":           func(i *Intent) { i.BranchPrefix = "refs/tags/feature/"; i.Ref = "refs/tags/feature/x" },
		"prefix makes an invalid ref":    func(i *Intent) { i.BranchPrefix = "refs/heads/f.lock/"; i.Ref = "refs/heads/f.lock/x" },
		"ref is only the prefix":         func(i *Intent) { i.Ref = i.BranchPrefix },
		"ref invalid":                    func(i *Intent) { i.Ref = "refs/heads/feature/a b" },
		"ref equals the default":         func(i *Intent) { i.DefaultRef = i.Ref },
		"ref escapes the prefix by name": func(i *Intent) { i.Ref = "refs/heads/featured" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			in := fixture()
			change(&in)
			if _, err := NewPlan(in); !errors.Is(err, ErrIntent) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
}

func TestBindingRefusals(t *testing.T) {
	cases := map[string]func(*Binding){
		"operation with a space":    func(b *Binding) { b.OperationID = "op id" },
		"workspace empty":           func(b *Binding) { b.WorkspaceID = "" },
		"runtime empty":             func(b *Binding) { b.RuntimeID = "" },
		"repository empty":          func(b *Binding) { b.RepositoryID = "" },
		"grant over 160 bytes":      func(b *Binding) { b.GrantID = strings.Repeat("g", 161) },
		"token with a slash":        func(b *Binding) { b.RuntimeID = "a/b" },
		"token with non-ASCII":      func(b *Binding) { b.WorkspaceID = "worké" },
		"source seal uppercase":     func(b *Binding) { b.SourceSeal = strings.Repeat("A", 64) },
		"source seal short":         func(b *Binding) { b.SourceSeal = strings.Repeat("a", 63) },
		"destination seal not hex":  func(b *Binding) { b.DestinationSeal = strings.Repeat("g", 64) },
		"destination seal too long": func(b *Binding) { b.DestinationSeal = strings.Repeat("b", 65) },
		"destination seal missing":  func(b *Binding) { b.DestinationSeal = "" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			in := fixture()
			change(&in.Binding)
			if _, err := NewPlan(in); !errors.Is(err, ErrIntent) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
	in := fixture()
	in.Binding.GrantID = strings.Repeat("g", 160)
	if _, err := NewPlan(in); err != nil {
		t.Fatal("160 byte token refused:", err)
	}
}

func TestTargetRefusalsAndBounds(t *testing.T) {
	label := func(n int) string { return strings.Repeat("a", n) }
	cases := map[string]func(*Target){
		"empty host":                func(t *Target) { t.Host = "" },
		"host over 253 bytes":       func(t *Target) { t.Host = strings.Repeat(label(63)+".", 4) + "com" },
		"label over 63 bytes":       func(t *Target) { t.Host = label(64) + ".com" },
		"label starts with dash":    func(t *Target) { t.Host = "-a.com" },
		"label ends with dash":      func(t *Target) { t.Host = "a-.com" },
		"underscore in host":        func(t *Target) { t.Host = "a_b.com" },
		"trailing dot":              func(t *Target) { t.Host = "github.com." },
		"host with a port":          func(t *Target) { t.Host = "github.com:22" },
		"host with userinfo":        func(t *Target) { t.Host = "user@github.com" },
		"port above range":          func(t *Target) { t.Port = 65536 },
		"negative port":             func(t *Target) { t.Port = -22 },
		"empty user":                func(t *Target) { t.User = "" },
		"user over 64 bytes":        func(t *Target) { t.User = strings.Repeat("u", 65) },
		"user with a space":         func(t *Target) { t.User = "a b" },
		"user with at sign":         func(t *Target) { t.User = "a@b" },
		"repository without suffix": func(t *Target) { t.Repository = "owner/project" },
		"single path component":     func(t *Target) { t.Repository = "project.git" },
		"empty path component":      func(t *Target) { t.Repository = "owner//project.git" },
		"dot component":             func(t *Target) { t.Repository = "./project.git" },
		"component with a space":    func(t *Target) { t.Repository = "own er/project.git" },
		"component over 255":        func(t *Target) { t.Repository = strings.Repeat("c", 256) + "/p.git" },
		"repository over 1024":      func(t *Target) { t.Repository = "a/" + strings.Repeat("b/", 520) + "p.git" },
		"query in repository":       func(t *Target) { t.Repository = "owner/project.git?x=1" },
		"colon in repository":       func(t *Target) { t.Repository = "owner:x/project.git" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			in := fixture()
			change(&in.Target)
			if _, err := NewPlan(in); !errors.Is(err, ErrIntent) {
				t.Fatalf("accepted: %v", err)
			}
		})
	}
	for name, change := range map[string]func(*Target){
		"port 1":             func(t *Target) { t.Port = 1 },
		"port 65535":         func(t *Target) { t.Port = 65535 },
		"63 byte label":      func(t *Target) { t.Host = label(63) + ".com" },
		"nested repository":  func(t *Target) { t.Repository = "group/sub/project.git" },
		"numeric host label": func(t *Target) { t.Host = "10.0.0.1" },
		"dashed label":       func(t *Target) { t.Host = "a-b.example" },
	} {
		t.Run("accepts "+name, func(t *testing.T) {
			in := fixture()
			change(&in.Target)
			if _, err := NewPlan(in); err != nil {
				t.Fatal(err)
			}
		})
	}
}

// Every limit, ref, manifest and identity is sealed: changing any one of them
// yields a different digest input, so an admitted digest cannot be reused.
func TestEveryRemainingFieldChangesTheCanonicalPlan(t *testing.T) {
	base, _ := NewPlan(fixture())
	cases := []struct {
		name   string
		change func(*Intent)
	}{
		{"expanded bytes", func(i *Intent) { i.Limits.ExpandedBytes-- }},
		{"object bytes", func(i *Intent) { i.Limits.ObjectBytes-- }},
		{"object count", func(i *Intent) { i.Limits.Objects-- }},
		{"delta depth", func(i *Intent) { i.Limits.DeltaDepth-- }},
		{"advertisement bytes", func(i *Intent) { i.Limits.AdvertisementBytes-- }},
		{"ref count", func(i *Intent) { i.Limits.RefCount-- }},
		{"default ref", func(i *Intent) { i.DefaultRef = "refs/heads/trunk" }},
		{"branch prefix", func(i *Intent) { i.BranchPrefix = "refs/heads/feature/o/"; i.Ref = "refs/heads/feature/o/other" }},
		{"base", func(i *Intent) { i.Base = i.Head }},
		{"known digest", func(i *Intent) { i.Known[0].Digest = strings.Repeat("e", 64) }},
		{"known size", func(i *Intent) { i.Known[0].Size++ }},
		{"object size", func(i *Intent) { i.Objects[0].Size++ }},
		{"extra introduced object", func(i *Intent) {
			i.Objects = append(i.Objects, Object{OID: strings.Repeat("e", 40), Kind: "blob", Digest: strings.Repeat("e", 64), Size: 1})
		}},
		{"kind of an extra object", func(i *Intent) {
			i.Objects = append(i.Objects, Object{OID: strings.Repeat("e", 40), Kind: "tree", Digest: strings.Repeat("e", 64), Size: 1})
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := fixture()
			tc.change(&in)
			p, err := NewPlan(in)
			if err != nil {
				t.Fatal("the variant is not itself a valid plan:", err)
			}
			if p.Canonical() == base.Canonical() {
				t.Fatal("unsealed input")
			}
		})
	}
	sha256Plan, err := NewPlan(fixture256())
	if err != nil {
		t.Fatal(err)
	}
	if sha256Plan.Canonical() == base.Canonical() {
		t.Fatal("object format is unsealed")
	}
}

func TestKnownManifestOrderDoesNotChangeTheCanonicalPlan(t *testing.T) {
	in := fixture()
	in.Known = append(in.Known, Object{OID: strings.Repeat("9", 40), Kind: "tree", Digest: strings.Repeat("a", 64), Size: 7})
	one, err := NewPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	in.Known[0], in.Known[1] = in.Known[1], in.Known[0]
	two, err := NewPlan(in)
	if err != nil {
		t.Fatal(err)
	}
	if one.Canonical() != two.Canonical() {
		t.Fatal("ordering changes canonical encoding")
	}
	got := one.Intent().Known
	if got[0].OID != strings.Repeat("9", 40) || got[1].OID != strings.Repeat("a", 40) {
		t.Fatalf("not sorted by object id: %+v", got)
	}
}

func TestPlanCopiesAreIndependent(t *testing.T) {
	p, err := NewPlan(fixture())
	if err != nil {
		t.Fatal(err)
	}
	c := p.Intent()
	c.Objects[0].Size = 1
	c.Known[0].Size = 1
	again := p.Intent()
	if again.Objects[0].Size != 100 || again.Known[0].Size != 100 {
		t.Fatal("Intent() aliases the sealed manifests")
	}
	if got := (*Plan)(nil).Intent(); got.Format != "" || got.Objects != nil || got.Known != nil {
		t.Fatalf("nil plan intent %+v", got)
	}
	if (&Plan{}).Canonical() != "" || (&Plan{}).OIDBytes() != 20 || (*Plan)(nil).OIDBytes() != 20 {
		t.Fatal("zero plan")
	}
}

func TestOIDHelpers(t *testing.T) {
	zero40, zero64 := strings.Repeat("0", 40), strings.Repeat("0", 64)
	for _, tc := range []struct {
		name   string
		format string
		id     string
		zero   bool
		want   bool
	}{
		{"sha1 ordinary", "sha1", strings.Repeat("a", 40), false, true},
		{"sha1 zero refused", "sha1", zero40, false, false},
		{"sha1 zero allowed", "sha1", zero40, true, true},
		{"sha256 ordinary", "sha256", strings.Repeat("a", 64), false, true},
		{"sha256 zero allowed", "sha256", zero64, true, true},
		{"sha256 with sha1 length", "sha256", strings.Repeat("a", 40), false, false},
		{"sha1 with sha256 length", "sha1", strings.Repeat("a", 64), true, false},
		{"unknown format", "sha512", strings.Repeat("a", 40), true, false},
		{"empty format", "", strings.Repeat("a", 40), true, false},
		{"uppercase", "sha1", strings.Repeat("A", 40), true, false},
		{"empty id", "sha1", "", true, false},
	} {
		if got := ValidOID(tc.format, tc.id, tc.zero); got != tc.want {
			t.Errorf("%s: %v", tc.name, got)
		}
	}
	for id, want := range map[string]bool{"": false, "0": true, "0000": true, "0001": false, "000x": false} {
		if IsZero(id) != want {
			t.Errorf("IsZero(%q)", id)
		}
	}
}

func TestRefNameRefusalsBeyondTheBasicSet(t *testing.T) {
	for _, bad := range []string{
		"", "refs/", "refs", "refs/heads/a b", "refs/heads/a~1", "refs/heads/a^b", "refs/heads/a\tb", "refs/heads/a\x7fb",
		"refs/heads/x.lock/y", "refs/heads/@{", "refs/heads//y", "refs/heads/.", "refs/heads/-", "refs/" + strings.Repeat("a", 1020),
	} {
		if ValidRef(bad) {
			t.Errorf("accepted %q", bad)
		}
	}
	if !ValidRef("refs/" + strings.Repeat("a", 1019)) {
		t.Error("a 1024 byte ref was refused")
	}
}

// The empty file is a legitimate object; a zero size must not be refused.
func TestManifestAcceptsZeroSizedObjects(t *testing.T) {
	in := fixture()
	in.Objects = append(in.Objects, Object{OID: strings.Repeat("e", 40), Kind: "blob", Digest: strings.Repeat("e", 64), Size: 0})
	if _, err := NewPlan(in); err != nil {
		t.Fatal(err)
	}
	in.Objects[1].Size = -1
	if _, err := NewPlan(in); err == nil {
		t.Fatal("negative size accepted")
	}
}

func TestCharacterClassesAtTheirBoundaries(t *testing.T) {
	long253 := strings.Repeat(strings.Repeat("a", 63)+".", 3) + strings.Repeat("a", 61)
	if len(long253) != 253 {
		t.Fatal(len(long253))
	}
	accepted := map[string]func(*Intent){
		"253 byte host":          func(i *Intent) { i.Target.Host = long253 },
		"host with 0 and 9":      func(i *Intent) { i.Target.Host = "h09.example" },
		"host with a and z":      func(i *Intent) { i.Target.Host = "az.za" },
		"user with every class":  func(i *Intent) { i.Target.User = "AZaz09_-." },
		"operation with Z and 0": func(i *Intent) { i.Binding.OperationID = "Z0A9z_a-." },
		"64 byte user":           func(i *Intent) { i.Target.User = strings.Repeat("u", 64) },
	}
	for name, change := range accepted {
		t.Run("accepts "+name, func(t *testing.T) {
			in := fixture()
			change(&in)
			if _, err := NewPlan(in); err != nil {
				t.Fatal(err)
			}
		})
	}
	refused := map[string]func(*Intent){
		"254 byte host":         func(i *Intent) { i.Target.Host = long253 + "a" },
		"host with a slash":     func(i *Intent) { i.Target.Host = "a/b.com" },
		"host with an at sign":  func(i *Intent) { i.Target.Host = "a@b.com" },
		"host with a colon":     func(i *Intent) { i.Target.Host = "a:b.com" },
		"user with a bracket":   func(i *Intent) { i.Target.User = "a[b" },
		"user with a backtick":  func(i *Intent) { i.Target.User = "a`b" },
		"token with an at sign": func(i *Intent) { i.Binding.GrantID = "a@b" },
		"token with a colon":    func(i *Intent) { i.Binding.GrantID = "a:b" },
		"token with a brace":    func(i *Intent) { i.Binding.GrantID = "a{b" },
	}
	for name, change := range refused {
		t.Run("refuses "+name, func(t *testing.T) {
			in := fixture()
			change(&in)
			if _, err := NewPlan(in); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}
