//go:build darwin

package process

import (
	"context"
	"encoding/binary"
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
