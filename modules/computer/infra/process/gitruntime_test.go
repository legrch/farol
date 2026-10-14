package process

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

func gitRuntimeFixture() *GitRuntimeResources {
	return &GitRuntimeResources{
		Git:         ExecutablePin{gitRuntimeImage, strings.Repeat("a", 64)},
		Files:       []ExecutablePin{{gitRuntimeData + "/gitconfig", strings.Repeat("b", 64)}, {gitRuntimeTemplates + "/description", strings.Repeat("c", 64)}},
		Directories: []GitRuntimeDirectory{{gitRuntimeTemplates, []string{"description"}}},
	}
}
func TestGitRuntimeOptionalPinnedSystemAttributes(t *testing.T) {
	r := gitRuntimeFixture()
	r.Files = append([]ExecutablePin{{gitRuntimeAttributes, strings.Repeat("d", 64)}}, r.Files...)
	if !validGitRuntime(r, []ExecutablePin{r.Git}) {
		t.Fatal("selected attributes refused")
	}
	for _, path := range []string{gitRuntimeAttributes + ".backup", gitRuntimeData + "/private"} {
		crossed := cloneGitRuntime(r)
		crossed.Files[0].Path = path
		if validGitRuntime(crossed, []ExecutablePin{r.Git}) {
			t.Fatal("non-selected data admitted", path)
		}
	}
	s, command := rootScopedFixture(t)
	s.Executables = append(s.Executables, r.Git)
	s.GitRuntimeResources = r
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(strings.Join(plan.arguments, "\n"), "="+gitRuntimeAttributes) ||
		!strings.Contains(plan.source, "(deny process-exec ") {
		t.Fatal("attributes lack literal data-only confinement")
	}
}

func TestGitRuntimeFiniteDeclarationAndClone(t *testing.T) {
	r := gitRuntimeFixture()
	if !validGitRuntime(r, []ExecutablePin{r.Git}) {
		t.Fatal("valid tree refused")
	}
	c := cloneGitRuntime(r)
	r.Directories[0].Entries[0] = "changed"
	r.Files[0].SHA256 = strings.Repeat("d", 64)
	if c.Directories[0].Entries[0] != "description" || sameGitRuntime(c, r) {
		t.Fatal("clone retained aliases")
	}
	for _, mode := range []string{"unselected-image", "foreign-file", "foreign-directory", "duplicate", "missing-config", "missing-parent-entry", "extra-entry", "traversal", "oversized", "order"} {
		t.Run(mode, func(t *testing.T) {
			r := gitRuntimeFixture()
			images := []ExecutablePin{r.Git}
			switch mode {
			case "unselected-image":
				images = nil
			case "foreign-file":
				r.Files[0].Path = "/Users/owner/private"
			case "foreign-directory":
				r.Directories[0].Path = gitRuntimeData
			case "duplicate":
				r.Files = append(r.Files, r.Files[1])
			case "missing-config":
				r.Files[0].Path = gitRuntimeTemplates + "/another"
			case "missing-parent-entry":
				r.Directories[0].Entries = nil
			case "extra-entry":
				r.Directories[0].Entries = []string{"description", "private"}
			case "traversal":
				r.Directories[0].Entries = []string{"../description"}
			case "oversized":
				r.Directories = make([]GitRuntimeDirectory, 9)
			case "order":
				slices.Reverse(r.Files)
			}
			if validGitRuntime(r, images) {
				t.Fatal("invalid resources accepted")
			}
		})
	}
}
func TestGitRuntimeCompilerIsLiteralDataOnlyAndSealed(t *testing.T) {
	s, command := rootScopedFixture(t)
	r := gitRuntimeFixture()
	s.Executables = append(s.Executables, r.Git)
	s.GitRuntimeResources = r
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(plan.source, "(deny process-exec ") || !strings.Contains(plan.source, "mount-root-literal") {
		t.Fatal("data execution/mount denial missing")
	}
	for _, f := range r.Files {
		if !strings.Contains(strings.Join(plan.arguments, "\n"), "="+f.Path) {
			t.Fatal("missing literal path")
		}
	}
	plain := s
	plain.GitRuntimeResources = nil
	previous, err := compileSeatbelt(plain, command)
	if err != nil || previous.digest == plan.digest {
		t.Fatal("resources absent from seal")
	}
	s.GitRuntimeResources = cloneGitRuntime(r)
	s.GitRuntimeResources.Files[0].Path = "/Library/Developer/private"
	if _, err := compileSeatbelt(s, command); err == nil {
		t.Fatal("arbitrary resource compiled")
	}
}

type gitRuntimeFactsDouble struct {
	*platformFactsDouble
	data map[string]platformFileFacts
	dirs map[string]gitRuntimeDirectoryFacts
}

func (f *gitRuntimeFactsDouble) gitRuntimeFile(_ context.Context, p string) (platformFileFacts, error) {
	return f.data[p], f.err
}
func (f *gitRuntimeFactsDouble) gitRuntimeDirectory(_ context.Context, p string) (gitRuntimeDirectoryFacts, error) {
	return f.dirs[p], f.err
}
func gitRuntimePlatformFixture(t *testing.T) (platformFixture, *gitRuntimeFactsDouble) {
	f := platformFixtureCPU(t)
	r := gitRuntimeFixture()
	f.descriptor.FilesystemClass = rootScopedMountBoundaryClass
	f.descriptor.GitRuntimeResources = r
	f.descriptor.Executables = append(f.descriptor.Executables, r.Git)
	f.facts.files[r.Git.Path] = platformFileFacts{identity: authority.RootIdentity{Device: "1", Inode: "git"}, path: r.Git.Path, sha256: r.Git.SHA256, size: 4096, mode: 0755, uid: 0, links: 1}
	actual := &gitRuntimeFactsDouble{platformFactsDouble: f.facts, data: map[string]platformFileFacts{}, dirs: map[string]gitRuntimeDirectoryFacts{}}
	for _, pin := range r.Files {
		actual.data[pin.Path] = platformFileFacts{identity: authority.RootIdentity{Device: "1", Inode: pin.Path}, path: pin.Path, sha256: pin.SHA256, size: 64, mode: 0644, uid: 0, links: 1}
	}
	actual.dirs[gitRuntimeTemplates] = gitRuntimeDirectoryFacts{platform: platformDirectoryFacts{path: gitRuntimeTemplates, filesystem: "apfs", mount: "/", identity: authority.RootIdentity{Device: "1", Inode: "templates"}, local: true}, mode: os.ModeDir | 0755, uid: 0, entries: "description"}
	return f, actual
}
func TestGitRuntimeStrategyRechecksDataAndDirectoryContinuity(t *testing.T) {
	for _, mode := range []string{"hash", "identity", "owner", "writable", "symlink", "links", "size", "directory-owner", "directory-listing", "directory-identity", "directory-mount", "directory-time"} {
		t.Run(mode, func(t *testing.T) {
			f, actual := gitRuntimePlatformFixture(t)
			strategy, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, actual)
			if err != nil {
				t.Fatal(err)
			}
			key := gitRuntimeData + "/gitconfig"
			data := actual.data[key]
			dir := actual.dirs[gitRuntimeTemplates]
			switch mode {
			case "hash":
				data.sha256 = strings.Repeat("e", 64)
			case "identity":
				data.identity.Inode = "replacement"
			case "owner":
				data.uid = 501
			case "writable":
				data.mode = 0664
			case "symlink":
				data.mode |= os.ModeSymlink
			case "links":
				data.links = 2
			case "size":
				data.size = 256*1024 + 1
			case "directory-owner":
				dir.uid = 501
			case "directory-listing":
				dir.entries += "\nprivate"
			case "directory-identity":
				dir.platform.identity.Inode = "replacement"
			case "directory-mount":
				dir.platform.mount = "/Volumes/foreign"
			case "directory-time":
				dir.changed = "changed"
			}
			actual.data[key], actual.dirs[gitRuntimeTemplates] = data, dir
			if strategy.inspect(context.Background()) == nil {
				t.Fatal("changed resource accepted")
			}
		})
	}
}
func TestGitRuntimeEmptyDataAndFrozenInput(t *testing.T) {
	f, actual := gitRuntimePlatformFixture(t)
	key := gitRuntimeData + "/gitconfig"
	data := actual.data[key]
	data.size = 0
	actual.data[key] = data
	strategy, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, actual)
	if err != nil {
		t.Fatal(err)
	}
	f.descriptor.GitRuntimeResources.Files[0].Path = "/foreign"
	f.descriptor.GitRuntimeResources.Directories[0].Entries[0] = "foreign"
	if err := strategy.inspect(context.Background()); err != nil {
		t.Fatal("input changed frozen support", err)
	}
}

func TestGitRuntimeDeclaredProfileFitsNativeCommandLimit(t *testing.T) {
	raw, err := os.ReadFile("../../../../tooling/shell-platform.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		GitRuntimeResources *GitRuntimeResources
		Executables         []ExecutablePin
	}
	if err := json.Unmarshal(raw, &declaration); err != nil || declaration.GitRuntimeResources == nil {
		t.Fatal("missing declared resources", err)
	}
	s, command := rootScopedFixture(t)
	s.GitRuntimeResources = declaration.GitRuntimeResources
	s.Executables = append(s.Executables, declaration.Executables...)
	command.Environment = seatbeltEnvironment(s, command.Write)
	policy, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	bound, err := policy.bind(command)
	if err != nil {
		t.Fatal("declared profile exceeds or fails native command contract", err)
	}
	if _, err := selectedLaunch(policy, bound); err != nil {
		t.Fatal(err)
	}
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	for _, ancestor := range []string{gitRuntimeData, gitRuntimeTemplates} {
		if !hasParameterRule(plan, "deny file-write-unlink (require-all", "literal", ancestor) {
			// Unlink rules wrap the literal in require-all, so inspect each exact
			// parameter independently rather than asserting a broad text match.
			found := false
			for i := 0; i+1 < len(plan.arguments) && plan.arguments[i] == "-D"; i += 2 {
				key, value, ok := strings.Cut(plan.arguments[i+1], "=")
				if ok && value == ancestor && strings.Contains(plan.source, "(deny file-write-unlink (require-all (literal (param \""+key+"\")) (vnode-type DIRECTORY)))") {
					found = true
				}
			}
			if !found {
				t.Fatal("resource ancestor can be removed", ancestor)
			}
		}
	}
}

type gitDataMeasurementDouble struct{ *measurementFilesystemDouble }

func (f *gitDataMeasurementDouble) pinGitRuntimeFile(ctx context.Context, pin ExecutablePin) (executableMeasurement, error) {
	return f.pinExecutable(ctx, pin)
}
func TestGitRuntimeRetainedDescriptorsConsumeOnResourceDrift(t *testing.T) {
	for _, drift := range []string{"none", "file", "directory-owner", "directory-mode", "directory-identity", "directory-alias", "partial-data", "missing-reader"} {
		t.Run(drift, func(t *testing.T) {
			_, command, launch, fs := rootMeasurementFixture(t)
			launch.gitRuntimeResources = gitRuntimeFixture()
			fs.directories[gitRuntimeTemplates] = directoryFacts{identity: authority.RootIdentity{Device: "1", Inode: "templates"}, mode: os.ModeDir | 0755, uid: 0}
			var selected launchFilesystem = &gitDataMeasurementDouble{fs}
			if drift == "partial-data" {
				fs.executableError = launch.gitRuntimeResources.Files[1].Path
			}
			if drift == "missing-reader" {
				selected = fs
			}
			m, err := retainLaunchFiles(context.Background(), command, launch, selected)
			if drift == "partial-data" || drift == "missing-reader" {
				if err == nil || m != nil {
					t.Fatal("missing/partial data reader accepted")
				}
				fs.assertCloses(t, 1)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer m.Close()
			opens := len(fs.handles)
			if err := m.Recheck(context.Background()); err != nil {
				t.Fatal(err)
			}
			if len(fs.handles) != opens {
				t.Fatal("data descriptors reopened")
			}
			facts := fs.directories[gitRuntimeTemplates]
			switch drift {
			case "file":
				fs.images[len(launch.pins)].fail = true
			case "directory-owner":
				facts.uid = 501
			case "directory-mode":
				facts.mode = os.ModeDir | 0775
			case "directory-identity":
				facts.identity.Inode = "replacement"
			case "directory-alias":
				fs.alias = gitRuntimeTemplates
			}
			fs.directories[gitRuntimeTemplates] = facts
			err = m.Recheck(context.Background())
			if drift == "none" {
				if err != nil {
					t.Fatal(err)
				}
				m.Close()
				m.Close()
			} else {
				if err == nil {
					t.Fatal("resource drift accepted")
				}
				if m.Recheck(context.Background()) == nil {
					t.Fatal("consumed measurement revived")
				}
			}
			if len(fs.handles) != opens {
				t.Fatal("resource drift reopened handles")
			}
			fs.assertCloses(t, 1)
		})
	}
}

// Literal declaration fixtures only; packaged native preparation is separate.
func TestGitRuntimePackagedProfileReusesPathParameters(t *testing.T) {
	raw, err := os.ReadFile("../../../../tooling/shell-platform.json")
	if err != nil {
		t.Fatal(err)
	}
	var declaration struct {
		GitRuntimeResources *GitRuntimeResources
		Executables         []ExecutablePin
	}
	if err := json.Unmarshal(raw, &declaration); err != nil || declaration.GitRuntimeResources == nil {
		t.Fatal("missing declared resources", err)
	}
	s, command := rootScopedFixture(t)
	s.GitRuntimeResources = declaration.GitRuntimeResources
	s.Executables = append(s.Executables, declaration.Executables...)
	const bundle = "/Users/fixture/.codex/worktrees/qualified-computer/farol/_output/package/Farol.app"
	s.ProtectedBundle = &ProtectedBundle{Path: bundle, Identity: authority.RootIdentity{Device: "1", Inode: "55"}}
	s.ProtectedImages = []ExecutablePin{
		{Path: bundle + "/Contents/Resources/app/farol-backend", SHA256: strings.Repeat("d", 64)},
		{Path: bundle + "/Contents/Frameworks/Electron Runtime.app/Contents/MacOS/Electron", SHA256: strings.Repeat("e", 64)},
	}
	s.RootVolumeOnly = true
	command.Executable = "/bin/bash"
	for _, pin := range s.Executables {
		if pin.Path == command.Executable {
			command.ExecutableSHA256 = pin.SHA256
		}
	}
	command.Args = []string{"--noprofile", "--norc", "-c", "builtin printf fixture"}
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]bool{}
	for i := 0; i+1 < len(plan.arguments) && plan.arguments[i] == "-D"; i += 2 {
		_, value, ok := strings.Cut(plan.arguments[i+1], "=")
		if !ok || values[value] {
			t.Fatal("duplicate or malformed path parameter", value)
		}
		values[value] = true
	}
	policy, err := NewSeatbelt(s, &confinementEvidenceDouble{})
	if err != nil {
		t.Fatal(err)
	}
	bound, err := policy.bind(command)
	if err != nil {
		t.Fatal("packaged profile does not fit unchanged native command limit", err)
	}
	if _, err := selectedLaunch(policy, bound); err != nil {
		t.Fatal(err)
	}
	for _, file := range s.GitRuntimeResources.Files {
		for _, rule := range []string{"allow file-read*", "deny file-write*", "deny process-exec"} {
			if !hasParameterRule(plan, rule, "literal", file.Path) {
				t.Fatal("lost data rule", rule, file.Path)
			}
		}
	}
	if !hasParameterRule(plan, "deny file-write*", "subpath", bundle) ||
		!hasParameterRule(plan, "allow process-exec", "literal", command.Executable) ||
		!hasParameterRule(plan, "deny file-write*", "literal", command.Executable) {
		t.Fatal("lost bundle or executable protection")
	}
}
