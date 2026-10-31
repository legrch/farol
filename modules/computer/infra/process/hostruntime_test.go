package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Value-only observations. These fixtures do not establish native trust or
// grant access to their named paths. Production supplies its own native reader.
type hostRuntimeFixtureFS struct {
	nodes         map[string]hostRuntimeNode
	reads         []string
	importsByPath map[string]hostMachOImports
}

func fixtureRuntimeNode(p, kind string, mode os.FileMode) hostRuntimeNode {
	sum := sha256.Sum256([]byte(p))
	hash := hex.EncodeToString(sum[:])
	return hostRuntimeNode{Path: p, Kind: kind, Device: "1", Inode: hash[:12], UID: 501, GID: 20, Mode: mode, Size: 10, Links: 1, Modified: "1", Changed: "1", SHA256: hash}
}
func runtimeFixture() *hostRuntimeFixtureFS {
	f := &hostRuntimeFixtureFS{nodes: map[string]hostRuntimeNode{}, importsByPath: map[string]hostMachOImports{}}
	for _, p := range []string{"/install", "/install/bin", "/install/lib"} {
		f.nodes[p] = fixtureRuntimeNode(p, "directory", os.ModeDir|0755)
	}
	f.nodes["/install/bin/git-real"] = fixtureRuntimeNode("/install/bin/git-real", "file", 0555)
	f.importsByPath["/install/bin/git-real"] = hostMachOImports{fileType: 2}
	f.nodes["/install/lib/data"] = fixtureRuntimeNode("/install/lib/data", "file", 0444)
	alias := fixtureRuntimeNode("/install/bin/git", "alias", os.ModeSymlink|0777)
	alias.LinkTarget = "git-real"
	f.nodes[alias.Path] = alias
	return f
}
func (f *hostRuntimeFixtureFS) uid() uint32 { return 501 }
func (f *hostRuntimeFixtureFS) node(ctx context.Context, p string) (hostRuntimeNode, error) {
	f.reads = append(f.reads, p)
	if ctx.Err() != nil {
		return hostRuntimeNode{}, ctx.Err()
	}
	n, ok := f.nodes[p]
	if !ok {
		return n, os.ErrNotExist
	}
	return n, nil
}
func (f *hostRuntimeFixtureFS) entries(ctx context.Context, p string) ([]string, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	var names []string
	for n := range f.nodes {
		if filepath.Dir(n) == p {
			names = append(names, filepath.Base(n))
		}
	}
	slices.Sort(names)
	return names, nil
}
func (f *hostRuntimeFixtureFS) resolve(ctx context.Context, p string) (string, error) {
	for limit := 0; limit < 33; limit++ {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		parts := strings.Split(strings.TrimPrefix(p, "/"), "/")
		current := "/"
		changed := false
		for i, part := range parts {
			current = filepath.Join(current, part)
			n, ok := f.nodes[current]
			if !ok {
				return "", os.ErrNotExist
			}
			if n.Kind == "alias" {
				target := n.LinkTarget
				if !filepath.IsAbs(target) {
					target = filepath.Join(filepath.Dir(current), target)
				}
				p = filepath.Join(append([]string{target}, parts[i+1:]...)...)
				changed = true
				break
			}
		}
		if !changed {
			return p, nil
		}
	}
	return "", errHostRuntime
}
func (f *hostRuntimeFixtureFS) imports(ctx context.Context, p string) (hostMachOImports, bool, error) {
	if ctx.Err() != nil {
		return hostMachOImports{}, false, ctx.Err()
	}
	v, ok := f.importsByPath[p]
	return v, ok, nil
}
func buildRuntimeFixture(f *hostRuntimeFixtureFS) (*HostRuntimePlan, error) {
	b := newHostRuntimeBuilder(context.Background(), f)
	if err := b.tree("/install", []string{"/install"}, 0); err != nil {
		return nil, err
	}
	return b.finish()
}
func TestHostRuntimeSealsExactInstalledInventory(t *testing.T) {
	f := runtimeFixture()
	p, err := buildRuntimeFixture(f)
	if err != nil {
		t.Fatal(err)
	}
	if !p.valid() || p.digest() == "" || !slices.Equal(p.frozen.ExecFiles, []string{"/install/bin/git-real"}) || len(p.frozen.ReadFiles) != 2 {
		t.Fatal("unbounded or incomplete plan")
	}
	original := p.digest()
	copy := cloneHostRuntime(p)
	copy.frozen.ExecFiles[0] = "/other"
	if p.digest() != original || sameHostRuntime(p, copy) {
		t.Fatal("plan aliases mutable copy")
	}
}
func TestHostRuntimeRejectsInventoryDrift(t *testing.T) {
	for _, field := range []string{"sha", "uid", "gid", "mode", "inode", "alias", "listing"} {
		t.Run(field, func(t *testing.T) {
			f := runtimeFixture()
			p, err := buildRuntimeFixture(f)
			if err != nil {
				t.Fatal(err)
			}
			n := f.nodes["/install/bin/git-real"]
			switch field {
			case "sha":
				n.SHA256 = strings.Repeat("a", 64)
			case "uid":
				n.UID = 502
			case "gid":
				n.GID = 80
			case "mode":
				n.Mode = 0777
			case "inode":
				n.Inode = "changed"
			case "alias":
				a := f.nodes["/install/bin/git"]
				a.LinkTarget = "other"
				f.nodes[a.Path] = a
			case "listing":
				f.nodes["/install/lib/new"] = fixtureRuntimeNode("/install/lib/new", "file", 0444)
			}
			f.nodes[n.Path] = n
			if p.recheck(context.Background(), f) == nil {
				t.Fatal("changed plan retained")
			}
		})
	}
}
func TestHostRuntimeRefusesGroupWritableInstallationAncestor(t *testing.T) {
	f := runtimeFixture()
	n := f.nodes["/install"]
	n.Mode = os.ModeDir | 0775
	f.nodes[n.Path] = n
	if _, err := buildRuntimeFixture(f); err == nil {
		t.Fatal("group-writable ancestor allowed another account to replace an executable")
	}
}

func TestHostRuntimeUsesSafeInstalledAlternativeAfterSharedWritableCandidate(t *testing.T) {
	f := &hostRuntimeFixtureFS{nodes: map[string]hostRuntimeNode{}, importsByPath: map[string]hostMachOImports{}}
	for _, p := range []string{
		"/opt", "/opt/homebrew", "/opt/homebrew/bin", "/opt/homebrew/Cellar", "/opt/homebrew/Cellar/git", "/opt/homebrew/Cellar/git/1", "/opt/homebrew/Cellar/git/1/bin",
		"/Library", "/Library/Developer", "/Library/Developer/CommandLineTools", "/Library/Developer/CommandLineTools/usr", "/Library/Developer/CommandLineTools/usr/bin", "/Library/Developer/CommandLineTools/usr/libexec", "/Library/Developer/CommandLineTools/usr/libexec/git-core", "/Library/Developer/CommandLineTools/usr/share", "/Library/Developer/CommandLineTools/usr/share/git-core", "/Library/Developer/CommandLineTools/usr/share/git-core/templates",
	} {
		f.nodes[p] = fixtureRuntimeNode(p, "directory", os.ModeDir|0755)
	}
	n := f.nodes["/opt/homebrew/bin"]
	n.Mode = os.ModeDir | 0775
	f.nodes[n.Path] = n
	brew := "/opt/homebrew/Cellar/git/1/bin/git"
	f.nodes[brew] = fixtureRuntimeNode(brew, "file", 0555)
	alias := fixtureRuntimeNode("/opt/homebrew/bin/git", "alias", os.ModeSymlink|0777)
	alias.LinkTarget = brew
	f.nodes[alias.Path] = alias
	apple := "/Library/Developer/CommandLineTools/usr/bin/git"
	f.nodes[apple] = fixtureRuntimeNode(apple, "file", 0555)
	f.importsByPath[apple] = hostMachOImports{fileType: 2}
	p, err := discoverHostRuntime(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(p.frozen.ExecFiles, []string{apple}) || slices.Contains(p.frozen.Path, "/opt/homebrew/bin") {
		t.Fatalf("untrusted candidate was granted or safe candidate was lost: %+v", p.frozen)
	}
	for _, unavailable := range p.frozen.Unavailable {
		if unavailable.Kind == "git" {
			t.Fatal("safe alternative was reported unavailable")
		}
	}
}
func TestHostRuntimeRejectsSharedWritablePythonBeforeUnsupportedAlternative(t *testing.T) {
	f := &hostRuntimeFixtureFS{nodes: map[string]hostRuntimeNode{}, importsByPath: map[string]hostMachOImports{}}
	for _, p := range []string{
		"/opt", "/opt/homebrew", "/opt/homebrew/bin", "/opt/homebrew/Cellar", "/opt/homebrew/Cellar/python@3.13", "/opt/homebrew/Cellar/python@3.13/1", "/opt/homebrew/Cellar/python@3.13/1/Frameworks", "/opt/homebrew/Cellar/python@3.13/1/Frameworks/Python.framework", "/opt/homebrew/Cellar/python@3.13/1/Frameworks/Python.framework/Versions", "/opt/homebrew/Cellar/python@3.13/1/Frameworks/Python.framework/Versions/3.13", "/opt/homebrew/Cellar/python@3.13/1/Frameworks/Python.framework/Versions/3.13/bin",
		"/usr", "/usr/local", "/usr/local/bin",
	} {
		f.nodes[p] = fixtureRuntimeNode(p, "directory", os.ModeDir|0755)
	}
	n := f.nodes["/opt/homebrew/bin"]
	n.Mode = os.ModeDir | 0775
	f.nodes[n.Path] = n
	brew := "/opt/homebrew/Cellar/python@3.13/1/Frameworks/Python.framework/Versions/3.13/bin/python3.13"
	f.nodes[brew] = fixtureRuntimeNode(brew, "file", 0555)
	alias := fixtureRuntimeNode("/opt/homebrew/bin/python3", "alias", os.ModeSymlink|0777)
	alias.LinkTarget = brew
	f.nodes[alias.Path] = alias
	f.nodes["/usr/local/bin/python3"] = fixtureRuntimeNode("/usr/local/bin/python3", "file", 0555)
	p, err := discoverHostRuntime(context.Background(), f)
	if err != nil {
		t.Fatal(err)
	}
	if len(p.frozen.Installations) != 0 || len(p.frozen.ExecFiles) != 0 || len(p.frozen.ReadFiles) != 0 || len(p.frozen.ReadTrees) != 0 || len(p.frozen.Path) != 0 {
		t.Fatal("unavailable installations retained runtime authority")
	}
	for _, unavailable := range p.frozen.Unavailable {
		if unavailable.Kind == "python" && unavailable.Code == "HOST_RUNTIME_LAYOUT_UNSUPPORTED" {
			return
		}
	}
	t.Fatalf("unsupported alternative was not reported unavailable: %+v", p.frozen.Unavailable)
}
func TestHostRuntimeRefusesUnsafeFilesAndUnknownHardlinks(t *testing.T) {
	for _, field := range []string{"owner", "writable", "link", "world-parent", "setuid"} {
		t.Run(field, func(t *testing.T) {
			f := runtimeFixture()
			n := f.nodes["/install/bin/git-real"]
			switch field {
			case "owner":
				n.UID = 502
			case "writable":
				n.Mode = 0775
			case "setuid":
				n.Mode |= os.ModeSetuid
			case "link":
				n.Links = 2
			case "world-parent":
				a := f.nodes["/install"]
				a.Mode = os.ModeDir | 0777
				f.nodes[a.Path] = a
			}
			f.nodes[n.Path] = n
			if _, err := buildRuntimeFixture(f); err == nil {
				t.Fatal("unsafe installation qualified")
			}
		})
	}
}
func TestHostRuntimeRefusesDependencyEscapeBeforeReadingIt(t *testing.T) {
	f := runtimeFixture()
	f.importsByPath["/install/bin/git-real"] = hostMachOImports{fileType: 2, libraries: []string{"/credentials/private"}}
	if _, err := buildRuntimeFixture(f); err == nil {
		t.Fatal("external dependency granted")
	}
	if slices.Contains(f.reads, "/credentials/private") {
		t.Fatal("out of scope file inspected")
	}
}
func TestHostRuntimeAliasesDirectoriesWithoutLosingTheirBinding(t *testing.T) {
	f := runtimeFixture()
	alias := fixtureRuntimeNode("/install/current", "alias", os.ModeSymlink|0777)
	alias.LinkTarget = "lib"
	f.nodes[alias.Path] = alias
	b := newHostRuntimeBuilder(context.Background(), f)
	if err := b.tree("/install/current", []string{"/install"}, 0); err != nil {
		t.Fatal(err)
	}
	p, err := b.finish()
	if err != nil {
		t.Fatal(err)
	}
	alias.LinkTarget = "bin"
	f.nodes[alias.Path] = alias
	if p.recheck(context.Background(), f) == nil {
		t.Fatal("alias drift accepted")
	}
}
func TestHostRuntimeBoundsTraversalAndOriginalCancellation(t *testing.T) {
	f := runtimeFixture()
	b := newHostRuntimeBuilder(context.Background(), f)
	if b.tree("/install", []string{"/install"}, 25) == nil {
		t.Fatal("depth cap ignored")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	b = newHostRuntimeBuilder(ctx, f)
	if b.tree("/install", []string{"/install"}, 0) == nil {
		t.Fatal("cancelled plan admitted")
	}
	b = newHostRuntimeBuilder(context.Background(), f)
	b.bytes = hostRuntimeMaxBytes + 1
	if _, err := b.finish(); err == nil {
		t.Fatal("byte cap ignored")
	}
}

func TestHostRuntimeHardlinkAliasesMustHaveIdenticalFacts(t *testing.T) {
	for _, drift := range []bool{false, true} {
		f := runtimeFixture()
		n := f.nodes["/install/lib/data"]
		n.Links = 2
		f.nodes[n.Path] = n
		n.Path = "/install/lib/alias"
		if drift {
			n.SHA256 = strings.Repeat("a", 64)
		}
		f.nodes[n.Path] = n
		_, err := buildRuntimeFixture(f)
		if (err != nil) != drift {
			t.Fatalf("hardlink facts drift=%v err=%v", drift, err)
		}
	}
}
func TestHostRuntimeExcludesNestedOptionalPackages(t *testing.T) {
	f := runtimeFixture()
	dir := "/install/lib/site-packages"
	f.nodes[dir] = fixtureRuntimeNode(dir, "directory", os.ModeDir|0755)
	f.nodes[dir+"/untrusted.py"] = fixtureRuntimeNode(dir+"/untrusted.py", "file", 0777)
	p, err := buildRuntimeFixture(f)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(p.frozen.DeniedTrees, []string{dir}) || slices.Contains(f.reads, dir+"/untrusted.py") {
		t.Fatal("optional packages inspected or no longer denied")
	}
}
func TestHostRuntimeMissingProgramsLeaveBaseShellAvailable(t *testing.T) {
	p, err := discoverHostRuntime(context.Background(), &hostRuntimeFixtureFS{nodes: map[string]hostRuntimeNode{}})
	if err != nil || !p.valid() || len(p.frozen.Installations) != 0 || len(p.frozen.ExecFiles) != 0 || len(p.frozen.Unavailable) != 2 {
		t.Fatal("optional installations became mandatory", err)
	}
	s, command := rootScopedFixture(t)
	s.HostRuntime = p
	command.Environment = seatbeltEnvironment(s, command.Write)
	if !slices.Contains(command.Environment, "GIT_CONFIG_NOSYSTEM=1") || !slices.Contains(command.Environment, "GIT_ATTR_NOSYSTEM=1") {
		t.Fatal("installed Git may read system config or attributes outside its approved scope")
	}
	if _, err := compileSeatbelt(s, command); err != nil {
		t.Fatal("base Shell refused", err)
	}
}

type hostRuntimePlatformFactsDouble struct {
	*platformFactsDouble
	runtime *hostRuntimeFixtureFS
}

func (f *hostRuntimePlatformFactsDouble) hostRuntime(ctx context.Context, p *HostRuntimePlan) error {
	return p.recheck(ctx, f.runtime)
}
func TestHostRuntimePlatformBindsExactPlanAndRechecksBeforeDispatch(t *testing.T) {
	f := platformFixtureCPU(t)
	runtimeFS := runtimeFixture()
	p, err := buildRuntimeFixture(runtimeFS)
	if err != nil {
		t.Fatal(err)
	}
	f.descriptor.FilesystemClass = rootScopedMountBoundaryClass
	f.descriptor.HostRuntimePolicy = InstalledHostRuntimeAssurance
	actual := &hostRuntimePlatformFactsDouble{f.facts, runtimeFS}
	strategy, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, actual)
	if err != nil {
		t.Fatal(err)
	}
	f.policy.HostRuntime = p
	f.policy, err = strategy.selectMountBoundaries(context.Background(), f.policy, f.original)
	if err != nil {
		t.Fatal(err)
	}
	f.original.Environment = seatbeltEnvironment(f.policy, f.original.Write)
	f.original.Confinement = nil
	f.original, err = (&Seatbelt{selection: f.policy}).bind(f.original)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog)
	if err != nil {
		t.Fatal(err)
	}
	if selected.Binding().AssuranceID != InstalledHostRuntimeAssurance {
		t.Fatal("mutable environment claimed protected platform assurance")
	}
	deadline := f.clock.Now().Add(time.Second)
	qualification, err := selected.BindInvocation(context.Background(), f.original, selected.WrappedCommand(), deadline)
	if err != nil || qualification.Qualify(context.Background(), selected.WrappedCommand()) != nil {
		t.Fatal("frozen plan refused", err)
	}
	// Caller mutation cannot alter the captured plan; host mutation must refuse.
	p.frozen.ExecFiles = nil
	if qualification.Qualify(context.Background(), selected.WrappedCommand()) != nil {
		t.Fatal("caller changed frozen plan")
	}
	node := runtimeFS.nodes["/install/lib/data"]
	node.SHA256 = strings.Repeat("b", 64)
	runtimeFS.nodes[node.Path] = node
	if qualification.Qualify(context.Background(), selected.WrappedCommand()) == nil {
		t.Fatal("changed installed runtime accepted")
	}
}
func TestHostRuntimeSupportRequiresExplicitExclusiveSelection(t *testing.T) {
	f := platformFixtureCPU(t)
	f.descriptor.HostRuntimePolicy = InstalledHostRuntimeAssurance
	if validPlatformSupport(f.descriptor) {
		t.Fatal("legacy filesystem mode accepted installed runtime")
	}
	f.descriptor.FilesystemClass = rootScopedMountBoundaryClass
	if !validPlatformSupport(f.descriptor) {
		t.Fatal("explicit mode refused")
	}
	f.descriptor.GitRuntimeResources = gitRuntimeFixture()
	if validPlatformSupport(f.descriptor) {
		t.Fatal("fixed and installed policies mixed")
	}
}
