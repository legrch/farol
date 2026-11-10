//go:build linux

package observation

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"

	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

// Real Linux directory descriptors; SYNTHETIC volume and birth facts. This tests
// the shared descriptor algorithm, not the Darwin/APFS adapter or a remount.
type linuxFixtureOperations struct {
	held       map[int]bool
	afterFacts func()
}

func (o *linuxFixtureOperations) opened(fd int, err error) (int, error) {
	if err == nil {
		o.held[fd] = true
	}
	return fd, err
}
func (o *linuxFixtureOperations) openRoot() (int, error) {
	return o.opened(syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0))
}
func (o *linuxFixtureOperations) openAt(fd int, name string) (int, error) {
	return o.opened(syscall.Openat(fd, name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0))
}
func (o *linuxFixtureOperations) close(fd int) error { delete(o.held, fd); return syscall.Close(fd) }
func (o *linuxFixtureOperations) uid() uint32        { return uint32(os.Getuid()) }
func (o *linuxFixtureOperations) stat(fd int) (fileIdentity, error) {
	var s syscall.Stat_t
	err := syscall.Fstat(fd, &s)
	return fileIdentity{Device: s.Dev, Inode: s.Ino, Mode: s.Mode, UID: s.Uid}, err
}
func (o *linuxFixtureOperations) facts(_ context.Context, fd int) (identity.Evidence, error) {
	f, err := o.stat(fd)
	if err != nil {
		return identity.Evidence{}, err
	}
	result := identity.Evidence{Schema: identity.EvidenceSchema, Filesystem: "apfs", VolumeUUID: "11111111-2222-3333-4444-555555555555", FileID: strconv.FormatUint(f.Inode, 10), BirthSeconds: "0", BirthNanoseconds: "0"}
	if o.afterFacts != nil {
		o.afterFacts()
	}
	return result, nil
}
func TestLinuxDescriptorWalkWithSyntheticVolumeFacts(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(base, "workspace")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	o := &linuxFixtureOperations{held: map[int]bool{}}
	got, err := observe(context.Background(), path, o)
	if err != nil || !got.Valid() {
		t.Fatalf("%v %v", got, err)
	}
	if len(o.held) != 0 {
		t.Fatal("descriptor leak")
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := observe(context.Background(), link, o); code(err) != "WORKSPACE_PATH_REFUSED" {
		t.Fatalf("target symlink: %v", err)
	}
	if _, err := observe(context.Background(), filepath.Join(link, "child"), o); code(err) != "WORKSPACE_PATH_REFUSED" {
		t.Fatalf("ancestor symlink: %v", err)
	}
	if len(o.held) != 0 {
		t.Fatal("descriptor leak after no-follow refusal")
	}
}
func TestLinuxActualRenameBetweenObservationAndRecheckIsRefused(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(base, "workspace")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	o := &linuxFixtureOperations{held: map[int]bool{}}
	o.afterFacts = func() {
		o.afterFacts = nil
		if err := os.Rename(path, path+"-old"); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
	}
	got, err := observe(context.Background(), path, o)
	if code(err) != "WORKSPACE_RACE_DETECTED" || got != (identity.Observation{}) {
		t.Fatalf("%v %v", got, err)
	}
	if len(o.held) != 0 {
		t.Fatal("descriptor leak after namespace race")
	}
}

// Synthetic filesystem evidence and mount identity with real Linux held file
// descriptors. This cannot qualify Darwin/APFS or mount instance protection.
func (o *linuxFixtureOperations) mount(fd int) (mountInstance, error) {
	if !o.held[fd] {
		return mountInstance{}, syscall.EBADF
	}
	return mountInstance{FSID: [2]int32{12, 34}, Filesystem: "synthetic-apfs",
		MountedOn: "/fixture", MountedFrom: "/dev/synthetic", Flags: 1}, nil
}
func TestLinuxHeldCandidateActualRenameAndSymlink(t *testing.T) {
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspace := filepath.Join(base, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	o := &linuxFixtureOperations{held: map[int]bool{}}
	h, err := hold(context.Background(), workspace, o)
	if err != nil {
		t.Fatal(err)
	}
	if len(o.held) == 0 {
		t.Fatal("candidate chain was not retained")
	}
	first, err := h.Snapshot()
	if err != nil || first.Binding.Path != workspace {
		t.Fatalf("%+v %v", first, err)
	}
	if err := h.Requalify(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "content"), []byte("ordinary churn"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := h.Requalify(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(workspace, workspace+"-old"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if code(h.Requalify(context.Background())) != "WORKSPACE_RACE_DETECTED" {
		t.Fatal("replaced name accepted")
	}
	if err := h.Close(); err != nil || len(o.held) != 0 {
		t.Fatalf("close %v: %d open fds", err, len(o.held))
	}
	link := filepath.Join(base, "link")
	if err := os.Symlink(workspace, link); err != nil {
		t.Fatal(err)
	}
	if got, err := hold(context.Background(), link, o); got != nil || code(err) != "WORKSPACE_PATH_REFUSED" || len(o.held) != 0 {
		t.Fatalf("symlink accepted/leaked: %v %v open=%d", got, err, len(o.held))
	}
}
