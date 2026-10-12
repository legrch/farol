package process

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/domain/authority"
)

// CPU control/binding tests ONLY. Fake native facts are explicit measurements,
// not kernel, native filesystem, sandbox installation, release or live evidence.
// No test invokes nativePlatformFacts, exec, version commands or a host probe.
type platformFactsDouble struct {
	actual      platformFacts
	owner       uint32
	backendPath string
	files       map[string]platformFileFacts
	directories map[string]platformDirectoryFacts
	err         error
	afterFile   func()
	reads       int
}

func (f *platformFactsDouble) effectiveUID() uint32 { return f.owner }
func (f *platformFactsDouble) platform(context.Context) (platformFacts, error) {
	f.reads++
	return f.actual, f.err
}
func (f *platformFactsDouble) backend(context.Context) (string, error) {
	f.reads++
	return f.backendPath, f.err
}
func (f *platformFactsDouble) file(_ context.Context, path string) (platformFileFacts, error) {
	f.reads++
	if f.afterFile != nil {
		f.afterFile()
	}
	value, ok := f.files[path]
	if !ok {
		return platformFileFacts{}, errors.New("missing fake file")
	}
	return value, f.err
}
func (f *platformFactsDouble) directory(_ context.Context, path string) (platformDirectoryFacts, error) {
	f.reads++
	value, ok := f.directories[path]
	if !ok {
		return platformDirectoryFacts{}, errors.New("missing fake directory")
	}
	return value, f.err
}

type platformFixture struct {
	descriptor RootScopedPlatformSupport
	facts      *platformFactsDouble
	clock      *testClock
	policy     SeatbeltSelection
	original   Command
	watchdog   WatchdogSelection
}

func platformFixtureCPU(t *testing.T) platformFixture {
	t.Helper()
	policy, command := rootScopedFixture(t)
	command.Executable = "/bin/bash"
	policy.Executables = []ExecutablePin{{command.Executable, command.ExecutableSHA256}}
	source := []byte("// explicit fake watchdog resource; not native evidence\n")
	hash := sha256.Sum256(source)
	descriptor := RootScopedPlatformSupport{
		ReleaseID: "fake-release", QualificationSHA256: strings.Repeat("c", 64), CompilerSHA256: strings.Repeat("d", 64),
		OS: "darwin", OSBuild: "25A123", Architecture: "arm64", Compiler: rootScopedPlatformCompiler,
		FilesystemClass: rootScopedPlatformClass, HostTrust: rootScopedPlatformTrust,
		Backend:   ExecutablePin{"/Users/owner/Applications/Farol.app/Contents/Resources/backend", strings.Repeat("e", 64)},
		Watchdog:  ExecutablePin{"/Users/owner/Applications/Farol.app/Contents/MacOS/helper", strings.Repeat("f", 64)},
		Mechanism: ExecutablePin{seatbeltExecutable, policy.MechanismSHA256}, WatchdogSourceSHA256: hex.EncodeToString(hash[:]),
		Imports: []ExecutablePin{{"/usr/share/sandbox/dyld-support.sb", strings.Repeat("a", 64)}}, Executables: slices.Clone(policy.Executables),
	}
	policy.ProtectedImages = []ExecutablePin{descriptor.Backend, descriptor.Watchdog}
	command.Environment = seatbeltEnvironment(policy, command.Write)
	bound, err := (&Seatbelt{selection: policy}).bind(command)
	if err != nil {
		t.Fatal(err)
	}
	facts := &platformFactsDouble{actual: platformFacts{descriptor.OS, descriptor.OSBuild, descriptor.Architecture}, owner: 501,
		backendPath: descriptor.Backend.Path, files: map[string]platformFileFacts{}, directories: map[string]platformDirectoryFacts{}}
	for i, pin := range platformPins(descriptor) {
		mode, uid := os.FileMode(0755), uint32(501)
		if i == 2 {
			uid = 0
		}
		if i >= 3 && i < 3+len(descriptor.Imports) {
			mode, uid = 0644, 0
		}
		facts.files[pin.Path] = platformFileFacts{identity: authority.RootIdentity{Device: "1", Inode: pin.Path}, size: 4096, path: pin.Path, sha256: pin.SHA256, mode: mode, uid: uid, links: 1}
	}
	for _, path := range []string{bound.Root, bound.Cwd, policy.Scratch} {
		identity := authority.RootIdentity{Device: "1", Inode: "scope"}
		if path == bound.Root {
			identity = bound.RootIdentity
		}
		if path == policy.Scratch {
			identity = policy.ScratchIdentity
		}
		facts.directories[path] = platformDirectoryFacts{path, "apfs", "/System/Volumes/Data", identity, true, false}
	}
	return platformFixture{descriptor, facts, &testClock{time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)}, policy, bound,
		WatchdogSelection{descriptor.Watchdog, source, descriptor.WatchdogSourceSHA256}}
}
func (f platformFixture) strategy(t *testing.T) *RootScopedPlatformStrategy {
	t.Helper()
	s, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func (f platformFixture) selectCommand(t *testing.T) *RootScopedPlatformSelection {
	t.Helper()
	selection, err := f.strategy(t).Select(context.Background(), f.policy, f.original, f.watchdog)
	if err != nil {
		t.Fatal(err)
	}
	return selection
}
func (f platformFixture) qualify(t *testing.T) (*RootScopedPlatformSelection, *RootScopedPlatformQualification, time.Time) {
	t.Helper()
	s := f.selectCommand(t)
	deadline := f.clock.value.Add(10 * time.Second)
	q, err := s.BindInvocation(context.Background(), f.original, s.WrappedCommand(), deadline)
	if err != nil {
		t.Fatal(err)
	}
	return s, q, deadline
}

func TestRootScopedPlatformDescriptorRefusesMissingUnknownOrMalformed(t *testing.T) {
	cases := map[string]func(*RootScopedPlatformSupport){
		"empty":             func(d *RootScopedPlatformSupport) { *d = RootScopedPlatformSupport{} },
		"release":           func(d *RootScopedPlatformSupport) { d.ReleaseID = "untrusted receipt/path" },
		"no-qualification":  func(d *RootScopedPlatformSupport) { d.QualificationSHA256 = "" },
		"zero-proof":        func(d *RootScopedPlatformSupport) { d.QualificationSHA256 = strings.Repeat("0", 64) },
		"compiler-source":   func(d *RootScopedPlatformSupport) { d.CompilerSHA256 = "" },
		"compiler-family":   func(d *RootScopedPlatformSupport) { d.Compiler = "legacy" },
		"non-darwin":        func(d *RootScopedPlatformSupport) { d.OS = "linux" },
		"wildcard-build":    func(d *RootScopedPlatformSupport) { d.OSBuild = "25*" },
		"unknown-arch":      func(d *RootScopedPlatformSupport) { d.Architecture = "any" },
		"filesystem":        func(d *RootScopedPlatformSupport) { d.FilesystemClass = "remote" },
		"host-assumption":   func(d *RootScopedPlatformSupport) { d.HostTrust = "" },
		"mechanism":         func(d *RootScopedPlatformSupport) { d.Mechanism.Path = "/custom/sandbox" },
		"imports-missing":   func(d *RootScopedPlatformSupport) { d.Imports = nil },
		"import-name":       func(d *RootScopedPlatformSupport) { d.Imports[0].Path = "/usr/share/sandbox/unrelated.sb" },
		"import-outside-os": func(d *RootScopedPlatformSupport) { d.Imports[0].Path = "/Users/owner/dyld-support.sb" },
		"exec-missing":      func(d *RootScopedPlatformSupport) { d.Executables = nil },
		"pin-conflict":      func(d *RootScopedPlatformSupport) { d.Watchdog.Path = d.Backend.Path },
		"uppercase-digest":  func(d *RootScopedPlatformSupport) { d.Backend.SHA256 = strings.Repeat("E", 64) },
		"source-zero":       func(d *RootScopedPlatformSupport) { d.WatchdogSourceSHA256 = strings.Repeat("0", 64) },
		"pin-count":         func(d *RootScopedPlatformSupport) { d.Executables = make([]ExecutablePin, 17) },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := platformFixtureCPU(t)
			change(&f.descriptor)
			if q, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil || q != nil {
				t.Fatal("bad support accepted")
			}
			if f.facts.reads != 0 {
				t.Fatal("malformed descriptor reached native facts")
			}
		})
	}
	if s, err := NewRootScopedPlatformStrategy(context.Background(), RootScopedPlatformSupport{}, &testClock{}); err == nil || s != nil {
		t.Fatal("public constructor accepted empty support")
	}
}

func TestRootScopedPlatformNativeFactsRefuseDriftAndWrongOwners(t *testing.T) {
	cases := map[string]func(platformFixture){
		"empty-file": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.size = 0
			f.facts.files[p] = v
		},
		"oversize-file": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.size = 128*1024*1024 + 1
			f.facts.files[p] = v
		},
		"no-file-identity": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.identity.Inode = ""
			f.facts.files[p] = v
		},
		"OS":           func(f platformFixture) { f.facts.actual.os = "linux" },
		"build":        func(f platformFixture) { f.facts.actual.build = "25B999" },
		"architecture": func(f platformFixture) { f.facts.actual.arch = "amd64" },
		"backend-path": func(f platformFixture) { f.facts.backendPath = "/another/backend" },
		"unknown":      func(f platformFixture) { f.facts.err = errors.New("unknown measurement") },
		"mechanism-owner": func(f platformFixture) {
			p := f.descriptor.Mechanism.Path
			v := f.facts.files[p]
			v.uid = 501
			f.facts.files[p] = v
		},
		"import-owner": func(f platformFixture) {
			p := f.descriptor.Imports[0].Path
			v := f.facts.files[p]
			v.uid = 501
			f.facts.files[p] = v
		},
		"foreign-owner": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.uid = 777
			f.facts.files[p] = v
		},
		"group-write": func(f platformFixture) {
			p := f.descriptor.Watchdog.Path
			v := f.facts.files[p]
			v.mode = 0775
			f.facts.files[p] = v
		},
		"world-write": func(f platformFixture) {
			p := f.descriptor.Watchdog.Path
			v := f.facts.files[p]
			v.mode = 0757
			f.facts.files[p] = v
		},
		"symlink": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.mode |= os.ModeSymlink
			f.facts.files[p] = v
		},
		"nonregular": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.mode |= os.ModeDir
			f.facts.files[p] = v
		},
		"noexec": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.mode = 0644
			f.facts.files[p] = v
		},
		"multilink": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.links = 2
			f.facts.files[p] = v
		},
		"named-alias": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.path = "/alias"
			f.facts.files[p] = v
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := platformFixtureCPU(t)
			change(f)
			if _, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil {
				t.Fatal("drift accepted")
			}
		})
	}
	// EVERY pinned dependency is checked against an independently supplied hash.
	f := platformFixtureCPU(t)
	for _, pin := range platformPins(f.descriptor) {
		t.Run(pin.Path, func(t *testing.T) {
			f := platformFixtureCPU(t)
			v := f.facts.files[pin.Path]
			v.sha256 = strings.Repeat("9", 64)
			f.facts.files[pin.Path] = v
			if _, err := newRootScopedPlatformStrategy(context.Background(), f.descriptor, f.clock, f.facts); err == nil {
				t.Fatal("hash drift accepted")
			}
		})
	}
}

func TestRootScopedPlatformOwnerInstallationHomeFirmlinksAndSharedRoles(t *testing.T) {
	f := platformFixtureCPU(t)
	home := "/Users/owner"
	f.policy.Home = home
	f.policy.Snapshot.Participant.Grant.Workspaces[0].Root = home
	f.policy.Snapshot.Approval.Workspaces[0].Root = home
	f.original.Root, f.original.Cwd, f.original.Write = home, home, true
	f.original.Confinement = nil
	f.original.Environment = seatbeltEnvironment(f.policy, true)
	var err error
	f.original, err = (&Seatbelt{selection: f.policy}).bind(f.original)
	if err != nil {
		t.Fatal(err)
	}
	f.facts.directories[home] = platformDirectoryFacts{home, "apfs", "/System/Volumes/Data", f.original.RootIdentity, true, false}
	s, q, deadline := f.qualify(t)
	if err := q.ValidateBound(context.Background(), f.original, s.WrappedCommand(), deadline); err != nil {
		t.Fatal("owner-owned HOME/Farol installation refused", err)
	}
	// Two attested roles may share one exact image; mismatching hashes refuse.
	g := platformFixtureCPU(t)
	g.descriptor.Watchdog = g.descriptor.Backend
	g.watchdog.Executable = g.descriptor.Watchdog
	g.policy.ProtectedImages = []ExecutablePin{g.descriptor.Backend}
	g.original.Confinement = nil
	g.original, err = (&Seatbelt{selection: g.policy}).bind(g.original)
	if err != nil {
		t.Fatal(err)
	}
	g.qualify(t)
	// Also accepted with root-owned images, without changing system import rules.
	for path, v := range f.facts.files {
		v.uid = 0
		f.facts.files[path] = v
	}
	f.qualify(t) // A fresh trusted constructor accepts the alternate system-owned class.
}

func TestRootScopedPlatformSelectionRequiresExactPolicyImagesAndResource(t *testing.T) {
	cases := map[string]func(*platformFixture){
		"legacy":                func(f *platformFixture) { f.policy.FilePolicy = authority.LegacyProtectedFiles },
		"network":               func(f *platformFixture) { f.policy.Network = authority.ApprovedNetwork },
		"exec-pin":              func(f *platformFixture) { f.policy.Executables[0].SHA256 = strings.Repeat("9", 64) },
		"mechanism":             func(f *platformFixture) { f.policy.MechanismSHA256 = strings.Repeat("9", 64) },
		"resource":              func(f *platformFixture) { f.watchdog.Source[0] = '!' },
		"resource-hash":         func(f *platformFixture) { f.watchdog.SourceSHA256 = strings.Repeat("9", 64) },
		"helper":                func(f *platformFixture) { f.watchdog.Executable.Path = "/wrong/helper" },
		"missing-protection":    func(f *platformFixture) { f.policy.ProtectedImages = nil },
		"mismatched-protection": func(f *platformFixture) { f.policy.ProtectedImages[0].SHA256 = strings.Repeat("9", 64) },
		"unsealed":              func(f *platformFixture) { f.original.Confinement = nil },
		"no-binding":            func(f *platformFixture) { f.original.Binding = nil },
		"invalid-utf8":          func(f *platformFixture) { f.original.Args = []string{string([]byte{255})} },
		"environment":           func(f *platformFixture) { f.original.Environment[0] = "PATH=/ambient" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := platformFixtureCPU(t)
			strategy := f.strategy(t)
			change(&f)
			if _, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog); err == nil {
				t.Fatal("changed selection accepted")
			}
		})
	}
}

func TestRootScopedPlatformImmutableSelectionAndInvocation(t *testing.T) {
	f := platformFixtureCPU(t)
	s, q, deadline := f.qualify(t)
	original := copyCommand(f.original)
	wrapped := s.WrappedCommand()
	binding := s.Binding()
	f.descriptor.Imports[0].SHA256 = strings.Repeat("9", 64)
	f.descriptor.Executables[0].Path = "/changed"
	f.policy.Executables[0].Path = "/changed"
	f.policy.ProtectedImages[0].Path = "/changed"
	f.policy.Snapshot.Participant.Grant.Workspaces[0].Root = "/changed"
	f.policy.Snapshot.Approval.Workspaces[0].Root = "/changed"
	f.original.Binding.SessionID = "changed"
	f.original.Confinement.ProfileSHA256 = strings.Repeat("9", 64)
	f.original.Environment[0] = "PATH=/changed"
	f.watchdog.Source[0] = '!'
	view := s.WrappedCommand()
	view.Args[0] = "changed"
	view.Input = append(view.Input, '!')
	view.Binding.SessionID = "changed"
	view.Confinement.ProfileSHA256 = strings.Repeat("9", 64)
	copied := *q
	if copied.InvocationSHA256() == "" || s.Binding() != binding || binding.AssuranceID != RootScopedPlatformAssurance || !digestValue(binding.SupportSHA256) || !digestValue(binding.SelectionSHA256) {
		t.Fatal("missing immutable bindings")
	}
	if err := copied.ValidateBound(context.Background(), original, wrapped, deadline); err != nil {
		t.Fatal("caller mutation changed frozen selection", err)
	}
}

// Replacing a caller-owned exported wrapper must not replace the selected
// private strategy. This tests Go whole-value assignment, not just slice copies.
func TestRootScopedPlatformCallerCannotReplaceSelectedStrategy(t *testing.T) {
	f := platformFixtureCPU(t)
	strategy := f.strategy(t)
	selected, err := strategy.Select(context.Background(), f.policy, f.original, f.watchdog)
	if err != nil {
		t.Fatal(err)
	}
	deadline := f.clock.value.Add(10 * time.Second)
	q, err := selected.BindInvocation(context.Background(), f.original, selected.WrappedCommand(), deadline)
	if err != nil {
		t.Fatal(err)
	}
	wrapped := selected.WrappedCommand()
	copied := *q
	*strategy = RootScopedPlatformStrategy{}
	*selected = RootScopedPlatformSelection{}
	*q = RootScopedPlatformQualification{}
	if err := copied.ValidateBound(context.Background(), f.original, wrapped, deadline); err != nil {
		t.Fatal("caller replaced private selected strategy", err)
	}
}

func TestRootScopedPlatformRejectsEveryInvocationFieldAndWrappedArgument(t *testing.T) {
	changes := map[string]func(*Command){
		"workspace": func(c *Command) { c.WorkspaceID = "foreign" }, "root": func(c *Command) { c.Root = "/foreign" },
		"cwd": func(c *Command) { c.Cwd = c.Root }, "device": func(c *Command) { c.RootIdentity.Device = "2" },
		"inode": func(c *Command) { c.RootIdentity.Inode += "changed" }, "image": func(c *Command) { c.Executable = "/another/image" },
		"image-sha": func(c *Command) { c.ExecutableSHA256 = strings.Repeat("9", 64) }, "argv": func(c *Command) { c.Args = append(c.Args, "extra") },
		"env": func(c *Command) { c.Environment[0] += "changed" }, "stdin": func(c *Command) { c.Input = append(c.Input, 0) },
		"write": func(c *Command) { c.Write = !c.Write }, "runtime": func(c *Command) { c.Binding.RuntimeID = "foreign" },
		"session": func(c *Command) { c.Binding.SessionID = "foreign" }, "model": func(c *Command) { c.Binding.ModelID = "foreign" },
		"admission": func(c *Command) { c.Binding.AdmissionID = "foreign" }, "no-binding": func(c *Command) { c.Binding = nil },
		"profile":   func(c *Command) { c.Confinement.ProfileSHA256 = strings.Repeat("9", 64) },
		"mechanism": func(c *Command) { c.Confinement.MechanismSHA256 = strings.Repeat("9", 64) }, "no-confinement": func(c *Command) { c.Confinement = nil },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := platformFixtureCPU(t)
			s, q, deadline := f.qualify(t)
			original, wrapped := copyCommand(f.original), s.WrappedCommand()
			change(&original)
			if err := q.ValidateBound(context.Background(), original, wrapped, deadline); err == nil {
				t.Fatal("changed original accepted")
			}
			wrapped = s.WrappedCommand()
			change(&wrapped)
			if err := q.Qualify(context.Background(), wrapped); err == nil {
				t.Fatal("changed wrapper accepted")
			}
		})
	}
	f := platformFixtureCPU(t)
	s, q, _ := f.qualify(t)
	for i := range s.WrappedCommand().Args {
		c := s.WrappedCommand()
		c.Args[i] += "changed"
		if q.Qualify(context.Background(), c) == nil {
			t.Fatalf("changed generated arg %d accepted", i)
		}
	}
	if q.Qualify(context.Background(), f.original) == nil {
		t.Fatal("plain-shell fallback accepted")
	}
}

func TestRootScopedPlatformProcessBudgetRetainsOriginalDeadline(t *testing.T) {
	f := platformFixtureCPU(t)
	s := f.selectCommand(t)
	deadline := f.clock.value.Add(authority.ProcessExecutionLifetime)
	q, err := s.BindInvocation(context.Background(), f.original, s.WrappedCommand(), deadline)
	if err != nil {
		t.Fatal(err)
	}
	f.clock.value = f.clock.value.Add(30 * time.Second)
	if err := q.ValidateBound(context.Background(), f.original, s.WrappedCommand(), deadline); err != nil {
		t.Fatal(err)
	}
	if err := q.ValidateBound(context.Background(), f.original, s.WrappedCommand(), deadline.Add(time.Second)); err == nil {
		t.Fatal("progress renewed original process budget")
	}
	f.clock.value = deadline
	if err := q.ValidateBound(context.Background(), f.original, s.WrappedCommand(), deadline); err == nil {
		t.Fatal("process admitted at original deadline")
	}
}

func TestRootScopedPlatformDeadlineFixedAcrossCopiesAndRefusals(t *testing.T) {
	f := platformFixtureCPU(t)
	s, q, deadline := f.qualify(t)
	copySelection := *s
	copyQ := *q
	for _, changed := range []time.Time{deadline.Add(time.Nanosecond), deadline.Add(-time.Nanosecond), time.Time{}} {
		if _, err := copySelection.BindInvocation(context.Background(), f.original, s.WrappedCommand(), changed); err == nil {
			t.Fatal("selection deadline changed")
		}
		if copyQ.ValidateBound(context.Background(), f.original, s.WrappedCommand(), changed) == nil {
			t.Fatal("qualified deadline changed")
		}
	}
	f.clock.value = deadline
	if q.Qualify(context.Background(), s.WrappedCommand()) == nil {
		t.Fatal("expired invocation accepted")
	}
	for _, delta := range []time.Duration{-time.Second, 0, authority.ProcessExecutionLifetime + time.Millisecond} {
		g := platformFixtureCPU(t)
		selected := g.selectCommand(t)
		if _, err := selected.BindInvocation(context.Background(), g.original, selected.WrappedCommand(), g.clock.value.Add(delta)); err == nil {
			t.Fatal("invalid original deadline accepted")
		}
		if _, err := selected.BindInvocation(context.Background(), g.original, selected.WrappedCommand(), g.clock.value.Add(10*time.Second)); err == nil {
			t.Fatal("refused binding renewed")
		}
	}
}

func TestRootScopedPlatformRevalidatesDriftAndDirectoryClass(t *testing.T) {
	cases := map[string]func(platformFixture){
		"replacement-same-bytes": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.identity.Inode = "replacement"
			f.facts.files[p] = v
		},
		"mode-drift": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.mode = 0555
			f.facts.files[p] = v
		},
		"owner-drift": func(f platformFixture) {
			p := f.descriptor.Backend.Path
			v := f.facts.files[p]
			v.uid = 0
			f.facts.files[p] = v
		},
		"effective-owner": func(f platformFixture) { f.facts.owner++ },
		"OS-update":       func(f platformFixture) { f.facts.actual.build = "25B124" },
		"helper-bytes": func(f platformFixture) {
			p := f.descriptor.Watchdog.Path
			v := f.facts.files[p]
			v.sha256 = strings.Repeat("9", 64)
			f.facts.files[p] = v
		},
		"missing": func(f platformFixture) { delete(f.facts.directories, f.original.Root) },
		"remote": func(f platformFixture) {
			v := f.facts.directories[f.original.Root]
			v.local = false
			f.facts.directories[f.original.Root] = v
		},
		"unknown-fs": func(f platformFixture) {
			v := f.facts.directories[f.original.Root]
			v.filesystem = "nfs"
			f.facts.directories[f.original.Root] = v
		},
		"nested-mount": func(f platformFixture) {
			v := f.facts.directories[f.original.Root]
			v.nested = true
			f.facts.directories[f.original.Root] = v
		},
		"mount-drift": func(f platformFixture) {
			v := f.facts.directories[f.original.Cwd]
			v.mount = "/another/mount"
			f.facts.directories[f.original.Cwd] = v
		},
		"device-drift": func(f platformFixture) {
			v := f.facts.directories[f.original.Cwd]
			v.identity.Device = "2"
			f.facts.directories[f.original.Cwd] = v
		},
		"scope-inode-drift": func(f platformFixture) {
			v := f.facts.directories[f.original.Cwd]
			v.identity.Inode = "replacement"
			f.facts.directories[f.original.Cwd] = v
		},
		"scratch-inode-drift": func(f platformFixture) {
			v := f.facts.directories[f.policy.Scratch]
			v.identity.Inode = "replacement"
			f.facts.directories[f.policy.Scratch] = v
		},
		"root-inode-drift": func(f platformFixture) {
			v := f.facts.directories[f.original.Root]
			v.identity.Inode = "replacement"
			f.facts.directories[f.original.Root] = v
		},
		"unknown": func(f platformFixture) { f.facts.err = errors.New("unknown fact") },
		"expiry-during-inspection": func(f platformFixture) {
			f.facts.afterFile = func() { f.clock.value = f.clock.value.Add(15 * time.Second) }
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := platformFixtureCPU(t)
			s, q, _ := f.qualify(t)
			change(f)
			if q.Qualify(context.Background(), s.WrappedCommand()) == nil {
				t.Fatal("drift or unknown accepted")
			}
		})
	}
	f := platformFixtureCPU(t)
	s, q, _ := f.qualify(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if q.Qualify(ctx, s.WrappedCommand()) == nil || q.Qualify(nil, s.WrappedCommand()) == nil {
		t.Fatal("invalid context accepted")
	}
	var zero RootScopedPlatformQualification
	if zero.Qualify(context.Background(), s.WrappedCommand()) == nil {
		t.Fatal("empty proof accepted")
	}
	nilClock := platformFixtureCPU(t)
	if _, err := newRootScopedPlatformStrategy(context.Background(), nilClock.descriptor, nil, nilClock.facts); err == nil {
		t.Fatal("nil clock accepted")
	}
}
