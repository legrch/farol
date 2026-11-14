//go:build darwin

package process

import (
	"context"
	"encoding/binary"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The fixtures below set and remove ACL entries only on disposable files
// inside this test's own temporary root. They prove the native descriptor
// reading and fail-closed classification on this host; they do not attest any
// installed Farol or tool layout.
type aclFixture struct {
	t    *testing.T
	root string
}

func newACLFixture(t *testing.T) *aclFixture {
	t.Helper()
	// hostRuntimeOpen compares the physical descriptor path; the temporary
	// directory must be addressed through its resolved /private/var location.
	physical, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	f := &aclFixture{t: t, root: physical}
	t.Cleanup(func() { f.dropACLs() })
	return f
}

func (f *aclFixture) dropACLs() {
	_ = filepath.WalkDir(f.root, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		_ = exec.Command("/bin/chmod", "-N", path).Run()
		return nil
	})
}

// grant applies /bin/chmod directives and registers restoration.
func (f *aclFixture) grant(path string, directives ...string) {
	f.t.Helper()
	for _, directive := range directives {
		if out, err := exec.Command("/bin/chmod", "+a", directive, path).CombinedOutput(); err != nil {
			f.t.Fatalf("chmod +a %q %s: %v: %s", directive, path, err, out)
		}
	}
}

func (f *aclFixture) file(name string) string {
	f.t.Helper()
	path := filepath.Join(f.root, name)
	if err := os.WriteFile(path, []byte("fixture\n"), 0o644); err != nil {
		f.t.Fatal(err)
	}
	return path
}

func (f *aclFixture) dir(name string) string {
	f.t.Helper()
	path := filepath.Join(f.root, name)
	if err := os.Mkdir(path, 0o755); err != nil {
		f.t.Fatal(err)
	}
	return path
}

func aclFixtureUser(t *testing.T) string {
	t.Helper()
	user, err := exec.Command("/usr/bin/id", "-un").Output()
	if err != nil {
		t.Fatal(err)
	}
	return strings.TrimSpace(string(user))
}

func aclFixtureContext(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// openForACL runs the guarded native open and reports whether it was refused.
func openForACL(t *testing.T, path string) error {
	t.Helper()
	file, _, err := hostRuntimeOpen(aclFixtureContext(t), path)
	if err != nil {
		return err
	}
	return file.Close()
}

func TestHostRuntimeACLFromBufferAcceptsMeasuredShapes(t *testing.T) {
	// Shapes byte-identical to the fgetattrlist results measured on this host.
	guid := make([]byte, 16)
	for i := range guid {
		guid[i] = byte(i)
	}
	build := func(count uint32, aces ...[2]uint32) []byte {
		size := 0
		if count != 0xffffffff {
			size = 44 + 24*int(count)
		}
		buffer := make([]byte, 12+size)
		binary.LittleEndian.PutUint32(buffer[0:4], uint32(len(buffer)))
		binary.LittleEndian.PutUint32(buffer[4:8], hostRuntimeACLPrologueWords)
		binary.LittleEndian.PutUint32(buffer[8:12], uint32(size))
		if size == 0 {
			return buffer
		}
		fsec := buffer[12:]
		binary.LittleEndian.PutUint32(fsec[0:4], hostRuntimeACLFilesecMagic)
		copy(fsec[4:20], guid)
		copy(fsec[20:36], guid)
		binary.LittleEndian.PutUint32(fsec[36:40], count)
		for i, ace := range aces {
			entry := fsec[44+24*i:]
			copy(entry[0:16], guid)
			binary.LittleEndian.PutUint32(entry[16:20], ace[0])
			binary.LittleEndian.PutUint32(entry[20:24], ace[1])
		}
		return buffer
	}
	for name, buffer := range map[string][]byte{
		"no-extended-security": build(0),
		"noacl-marker":         build(0xffffffff),
		"deny-delete":          build(1, [2]uint32{hostRuntimeACEDeny, 1 << 4}),
		"inherited-deny":       build(1, [2]uint32{hostRuntimeACEDeny | 1<<4, 1 << 4}),
		"allow-read":           build(1, [2]uint32{hostRuntimeACEPermit, 1<<1 | 1<<7 | 1<<11}),
		"allow-execute":        build(1, [2]uint32{hostRuntimeACEPermit, 1 << 3}),
		"deny-then-read":       build(2, [2]uint32{hostRuntimeACEDeny, 1 << 4}, [2]uint32{hostRuntimeACEPermit, 1 << 1}),
		"generic-read-only":    build(1, [2]uint32{hostRuntimeACEPermit, 1 << 24}),
	} {
		t.Run(name, func(t *testing.T) {
			if err := hostRuntimeACLFromBuffer(buffer); err != nil {
				t.Fatalf("safe ACL refused: %v", err)
			}
		})
	}
}

func TestHostRuntimeACLFromBufferFailsClosed(t *testing.T) {
	guid := make([]byte, 16)
	build := func(count uint32, aces ...[2]uint32) []byte {
		size := 44 + 24*int(count)
		buffer := make([]byte, 12+size)
		binary.LittleEndian.PutUint32(buffer[0:4], uint32(len(buffer)))
		binary.LittleEndian.PutUint32(buffer[4:8], hostRuntimeACLPrologueWords)
		binary.LittleEndian.PutUint32(buffer[8:12], uint32(size))
		fsec := buffer[12:]
		binary.LittleEndian.PutUint32(fsec[0:4], hostRuntimeACLFilesecMagic)
		copy(fsec[4:20], guid)
		copy(fsec[20:36], guid)
		binary.LittleEndian.PutUint32(fsec[36:40], count)
		for i, ace := range aces {
			entry := fsec[44+24*i:]
			copy(entry[0:16], guid)
			binary.LittleEndian.PutUint32(entry[16:20], ace[0])
			binary.LittleEndian.PutUint32(entry[20:24], ace[1])
		}
		return buffer
	}
	mutate := func(buffer []byte, at int, value uint32) []byte {
		binary.LittleEndian.PutUint32(buffer[at:at+4], value)
		return buffer
	}
	for name, buffer := range map[string][]byte{
		"empty":                         {},
		"truncated":                     build(0)[:6],
		"length-prefix-mismatch":        mutate(build(0), 0, 3),
		"prologue-word-deviation":       mutate(build(0), 4, 9),
		"filesec-magic-mismatch":        mutate(build(0), 12+0, 0x012cc16e),
		"entry-count-over-max":          mutate(build(0), 12+36, 129),
		"size-field-mismatch":           mutate(build(0), 8, 43),
		"unknown-kind-audit":            build(1, [2]uint32{3, 1 << 1}),
		"unknown-flag-inherited-future": build(1, [2]uint32{hostRuntimeACEPermit | 1<<9, 1 << 1}),
		"unknown-right-future":          build(1, [2]uint32{hostRuntimeACEPermit, 1 << 27}),
		"allow-write-data":              build(1, [2]uint32{hostRuntimeACEPermit, 1 << 2}),
		"allow-generic-write":           build(1, [2]uint32{hostRuntimeACEPermit, 1 << 23}),
		"allow-generic-all":             build(1, [2]uint32{hostRuntimeACEPermit, 1 << 21}),
		"allow-delete":                  build(1, [2]uint32{hostRuntimeACEPermit, 1 << 4}),
		"allow-write-security":          build(1, [2]uint32{hostRuntimeACEPermit, 1 << 12}),
		"allow-take-ownership":          build(1, [2]uint32{hostRuntimeACEPermit, 1 << 13}),
		"inherited-allow-write":         build(1, [2]uint32{hostRuntimeACEPermit | 1<<4, 1 << 2}),
	} {
		t.Run(name, func(t *testing.T) {
			if err := hostRuntimeACLFromBuffer(buffer); err == nil {
				t.Fatal("unqualified ACL accepted")
			}
		})
	}
}

func TestHostRuntimeACLNativeFixtureMatrix(t *testing.T) {
	user := aclFixtureUser(t)
	for name, spec := range map[string]struct {
		directives []string
		isDir      bool
		refused    bool
	}{
		"no-acl":               {},
		"deny-only":            {directives: []string{"everyone deny delete"}},
		"allow-read-only":      {directives: []string{user + " allow read"}},
		"deny-then-allow-read": {directives: []string{"everyone deny delete", user + " allow read"}},
		"allow-write":          {directives: []string{user + " allow write"}, refused: true},
		"allow-delete":         {directives: []string{user + " allow delete"}, refused: true},
		"allow-writeattr":      {directives: []string{user + " allow writeattr"}, refused: true},
		"allow-writesecurity":  {directives: []string{user + " allow writesecurity"}, refused: true},
		"allow-chown":          {directives: []string{user + " allow chown"}, refused: true},
		"dir-allow-add-file":   {directives: []string{user + " allow add_file"}, isDir: true, refused: true},
		"acl-unreadable":       {directives: []string{user + " deny readsecurity"}, refused: true},
	} {
		t.Run(name, func(t *testing.T) {
			f := newACLFixture(t)
			path := f.root
			if !spec.isDir {
				path = f.file(name + ".bin")
			}
			f.grant(path, spec.directives...)
			if err := openForACL(t, path); (err != nil) != spec.refused {
				t.Fatalf("refused=%v, want %v: %v", err != nil, spec.refused, err)
			}
		})
	}
}

func TestHostRuntimeACLInheritedEntriesFollowDirectoryGrant(t *testing.T) {
	user := aclFixtureUser(t)
	for name, spec := range map[string]struct {
		directive string
		refused   bool
	}{
		"inherited-deny-delete": {"everyone deny delete,file_inherit", false},
		"inherited-allow-read":  {user + " allow read,file_inherit", false},
		"inherited-allow-write": {user + " allow write,file_inherit", true},
	} {
		t.Run(name, func(t *testing.T) {
			f := newACLFixture(t)
			dir := f.dir(name)
			f.grant(dir, spec.directive)
			child := filepath.Join(dir, "child.bin")
			if err := os.WriteFile(child, []byte("fixture\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := openForACL(t, child); (err != nil) != spec.refused {
				t.Fatalf("refused=%v, want %v: %v", err != nil, spec.refused, err)
			}
		})
	}
}

// A previously accepted measurement must stop validating once an allow entry
// appears: plan rechecks measure through the same native filesystem node.
func TestHostRuntimeACLDriftInvalidatesHeldMeasurement(t *testing.T) {
	user := aclFixtureUser(t)
	f := newACLFixture(t)
	path := f.file("drift.bin")
	ctx := aclFixtureContext(t)
	fs := nativeHostRuntimeFilesystem{}
	if _, err := fs.node(ctx, path); err != nil {
		t.Fatalf("clean fixture refused: %v", err)
	}
	f.grant(path, user+" allow write")
	if _, err := fs.node(ctx, path); err == nil {
		t.Fatal("post-grant measurement retained the accepted verdict")
	}
}

// Read-only parser witness. No process, runtime approval, confinement or user
// program is dispatched; missing installations are explicitly not covered.
func TestNativeHostRuntimeKnownImages(t *testing.T) {
	for _, alias := range []string{"/Library/Developer/CommandLineTools/usr/bin/git", "/opt/homebrew/bin/git", "/opt/homebrew/bin/python3"} {
		t.Run(alias, func(t *testing.T) {
			p, err := filepath.EvalSymlinks(alias)
			if os.IsNotExist(err) {
				t.Skip("optional installed image absent")
			}
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			fs := nativeHostRuntimeFilesystem{}
			node, err := fs.node(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			imports, macho, err := fs.imports(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			if !macho || imports.fileType != 2 || node.SHA256 == "" {
				t.Fatal("not a measured ARM64 executable")
			}
			t.Logf("bounded parser only: libraries=%q rpaths=%q", imports.libraries, imports.rpaths)
		})
	}
}

func TestNativeHostRuntimeDiscoveryReadOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	plan, err := DiscoverInstalledHostRuntime(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, selected := range plan.frozen.Installations {
		t.Logf("read-only selected %s layout %s", selected.Kind, selected.Root)
	}
	for _, missing := range plan.frozen.Unavailable {
		t.Logf("not qualified: %s %s", missing.Kind, missing.Code)
	}
	t.Logf("read-only inventory: nodes=%d exec=%d mutable-parents=%d; no dispatch authority", len(plan.frozen.Nodes), len(plan.frozen.ExecFiles), len(plan.frozen.MutableParents))
}

type observedNativeHostRuntimeFS struct {
	nativeHostRuntimeFilesystem
	last string
}

func (f *observedNativeHostRuntimeFS) node(ctx context.Context, p string) (hostRuntimeNode, error) {
	f.last = p
	return f.nativeHostRuntimeFilesystem.node(ctx, p)
}
func TestNativeHostRuntimeLayoutBoundaries(t *testing.T) {
	for _, kind := range []string{"git", "python"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			f := &observedNativeHostRuntimeFS{}
			for _, alias := range hostRuntimeCandidates(kind) {
				physical, err := f.resolve(ctx, alias)
				if os.IsNotExist(err) {
					continue
				}
				if err != nil {
					t.Fatal(err)
				}
				layout, boundaries, err := hostRuntimeLayoutFor(kind, alias, physical)
				if err != nil {
					t.Fatal(err)
				}
				b := newHostRuntimeBuilder(ctx, f)
				b.mainExecutable = physical
				image, err := b.physical(alias, boundaries)
				if err != nil {
					info, statErr := os.Lstat(f.last)
					if statErr == nil && info.IsDir() && info.Mode().Perm()&0020 != 0 {
						plan, discoverErr := DiscoverInstalledHostRuntime(ctx)
						if discoverErr != nil {
							t.Fatal(discoverErr)
						}
						for _, selected := range plan.frozen.Installations {
							if selected.Kind == kind {
								if selected.Image == physical {
									t.Fatal("group-writable installation was granted authority")
								}
								t.Logf("shared-writable candidate refused; selected another qualified %s installation", kind)
								return
							}
						}
						for _, unavailable := range plan.frozen.Unavailable {
							if unavailable.Kind == kind {
								switch unavailable.Code {
								case "HOST_RUNTIME_QUALIFICATION_UNAVAILABLE", "HOST_RUNTIME_DISCOVERY_UNAVAILABLE", "HOST_RUNTIME_LAYOUT_UNSUPPORTED":
									t.Logf("untrusted group-writable candidate refused; %s unavailable: %s", kind, unavailable.Code)
									return
								}
							}
						}
						t.Fatalf("unsafe installation was not reported unavailable: %+v", plan.frozen.Unavailable)
					}
					t.Fatalf("image selection: %v last=%s", err, f.last)
				}
				if err := b.file(image, boundaries); err != nil {
					t.Fatalf("image closure: %v last=%s", err, f.last)
				}
				for _, tree := range layout.trees {
					if err := b.tree(tree, boundaries, 0); err != nil {
						t.Fatalf("tree: %v last=%s", err, f.last)
					}
				}
				if _, err := b.finish(); err != nil {
					t.Fatalf("final snapshot: %v last=%s", err, f.last)
				}
				return
			}
			t.Skip("optional installation absent")
		})
	}
}

// Native metadata plus CPU compilation only, not an execution attestation.
func TestNativeHostRuntimeProfileFitsOriginalCommandBudget(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	p, err := DiscoverInstalledHostRuntime(ctx)
	if err != nil {
		t.Fatal(err)
	}
	s, command := rootScopedFixture(t)
	s.HostRuntime = p
	s.ProtectedBundle = &ProtectedBundle{Path: "/Users/owner/Applications/Farol.app", Identity: authority.RootIdentity{Device: "1", Inode: "42"}}
	s.ProtectedState = &ProtectedBundle{Path: "/Users/owner/Library/Application Support/io.github.legrch.farol/go-core/computer", Identity: authority.RootIdentity{Device: "1", Inode: "43"}}
	command.Environment = seatbeltEnvironment(s, command.Write)
	plan, err := compileSeatbelt(s, command)
	if err != nil {
		t.Fatal(err)
	}
	command.Executable, command.ExecutableSHA256 = seatbeltExecutable, s.MechanismSHA256
	command.Args = append(plan.arguments, "/bin/bash", "--noprofile", "--norc", "-c", "builtin printf fixture")
	if !validCommand(command) {
		t.Fatalf("native installed closure exceeds original command limit: source=%d arguments=%d", len(plan.source), len(command.Args))
	}
	t.Logf("bounded installed closure: nodes=%d executable-files=%d profile-bytes=%d", len(p.frozen.Nodes), len(p.frozen.ExecFiles), len(plan.source))
}
