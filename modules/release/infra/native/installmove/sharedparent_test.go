//go:build darwin || linux

package installmove

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func sharedLocation(t *testing.T, f *fixture, right bool) Identity {
	t.Helper()
	l := &f.left
	if right {
		l = &f.right
	}
	old := f.path(*l)
	l.Name = "Farol.app"
	l.Parent.Kind = SharedApplicationsParent
	if _, err := os.Lstat(old); err == nil {
		if err := os.Rename(old, f.path(*l)); err != nil {
			t.Fatal(err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	return l.Parent.Identity
}

// Root/admin metadata is injected only for the parent of actual disposable
// entries. No chown, platform waiver, or production Linux backend is involved.
func sharedMetadata(m metadata, uid, gid, permissions uint32) metadata {
	m.uid, m.gid = uid, gid
	m.mode = m.mode&unix.S_IFMT | permissions
	m.owner = uid == uint32(unix.Geteuid())
	m.protected = m.mode&0022 == 0
	return m
}
func sharedBackend(native backend, parent Identity, uid, gid, permissions uint32) *faultBackend {
	return &faultBackend{backend: native, heldFn: func(fd int) (metadata, error) {
		m, err := native.held(fd)
		if m.identity == parent {
			m = sharedMetadata(m, uid, gid, permissions)
		}
		return m, err
	}}
}

func TestSharedParentRenameAndExchange(t *testing.T) {
	for _, exchange := range []bool{false, true} {
		for _, right := range []bool{false, true} {
			t.Run(map[bool]string{false: "rename/", true: "exchange/"}[exchange]+map[bool]string{false: "left", true: "right"}[right], func(t *testing.T) {
				f := newFixture(t, exchange, false)
				parent := sharedLocation(t, f, right)
				b := sharedBackend(testNative(), parent, 0, 80, 0775)
				o := f.operation(exchange, b, nil)
				// Parent roles are copied with their locations at construction.
				if right {
					f.right.Parent.Kind = OwnedParent
				} else {
					f.left.Parent.Kind = OwnedParent
				}
				if err := o.Run(context.Background()); err != nil {
					t.Fatal(err)
				}
				assertEntry(t, f.right, f.le)
				if exchange {
					assertEntry(t, f.left, f.re)
				} else {
					assertAbsent(t, f.left)
				}
				for _, p := range []Directory{f.left.Parent, f.right.Parent} {
					if _, err := p.File.Stat(); err != nil {
						t.Fatal("borrowed parent closed", err)
					}
				}
			})
		}
	}
}

func TestSharedParentClosedRoleAndLeaf(t *testing.T) {
	for _, kind := range []ParentKind{OwnedParent, SharedApplicationsParent, ParentKind(2), ParentKind(255)} {
		for _, name := range []string{"Farol.app", "staged.app", "previous.app", "failed.app"} {
			f := newFixture(t, false, false)
			left := f.left
			left.Name = name
			left.Parent.Kind = kind
			o, err := prepare(left, f.right, f.le, Identity{}, time.Now().Add(time.Minute), func(context.Context) error { return nil }, false, testNative())
			valid := kind == OwnedParent || kind == SharedApplicationsParent && name == "Farol.app"
			if valid {
				if err != nil || o == nil {
					t.Fatalf("valid kind=%d leaf=%s: %v", kind, name, err)
				}
			} else {
				wantFailure(t, err, "input", false, false)
			}
		}
	}
}

func TestSharedParentProtectionMatchesSelectedHelper(t *testing.T) {
	for _, tc := range []struct {
		name           string
		uid, gid, mode uint32
		accepted       bool
	}{
		{"admin-group-writable", 0, 80, 0775, true},
		{"nonadmin-readonly-group", 0, 81, 0755, true},
		{"admin-world-writable", 0, 80, 0777, false},
		{"nonadmin-group-writable", 0, 81, 0775, false},
		{"nonroot-owner", uint32(unix.Geteuid()) + 1, 80, 0775, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, false, false)
			parent := sharedLocation(t, f, false)
			b := sharedBackend(testNative(), parent, tc.uid, tc.gid, tc.mode)
			called := false
			err := f.operation(false, b, func(context.Context) error { called = true; return nil }).Run(context.Background())
			if tc.accepted {
				if err != nil {
					t.Fatal(err)
				}
				assertEntry(t, f.right, f.le)
			} else {
				wantFailure(t, err, "parent_replaced", false, false)
				if called {
					t.Fatal("invalid shared parent reached fence")
				}
				assertEntry(t, f.left, f.le)
				assertAbsent(t, f.right)
			}
		})
	}
}

func TestSharedRoleDoesNotAcceptNonDirectory(t *testing.T) {
	f := newFixture(t, false, false)
	parent := sharedLocation(t, f, false)
	native := testNative()
	b := sharedBackend(native, parent, 0, 80, 0775)
	held := b.heldFn
	b.heldFn = func(fd int) (metadata, error) {
		m, e := held(fd)
		if m.identity == parent {
			m.directory = false
			m.mode = m.mode&07777 | unix.S_IFREG
		}
		return m, e
	}
	wantFailure(t, f.operation(false, b, nil).Run(context.Background()), "parent_replaced", false, false)
}

func TestSharedParentDoesNotRelaxAppEntryOwnership(t *testing.T) {
	if unix.Geteuid() == 0 {
		t.Skip("root is the effective owner on this host")
	}
	f := newFixture(t, false, false)
	parent := sharedLocation(t, f, false)
	native := testNative()
	b := sharedBackend(native, parent, 0, 80, 0775)
	b.namedFn = func(fd int, name string) (metadata, bool, error) {
		m, p, e := native.named(fd, name)
		if m.identity == f.le {
			m = sharedMetadata(m, 0, 80, 0755)
		}
		return m, p, e
	}
	wantFailure(t, f.operation(false, b, nil).Run(context.Background()), "source_replaced", false, false)
	assertEntry(t, f.left, f.le)
	assertAbsent(t, f.right)
}

func TestDefaultOwnedParentDoesNotAcceptRootParent(t *testing.T) {
	if unix.Geteuid() == 0 {
		t.Skip("root is the effective owner on this host")
	}
	f := newFixture(t, false, false)
	if f.left.Parent.Kind != OwnedParent || OwnedParent != 0 {
		t.Fatal("default parent is not private")
	}
	b := sharedBackend(testNative(), f.left.Parent.Identity, 0, 80, 0755)
	wantFailure(t, f.operation(false, b, nil).Run(context.Background()), "parent_replaced", false, false)
	assertEntry(t, f.left, f.le)
	assertAbsent(t, f.right)
}

func TestOwnedParentStillRejectsAdminGroupWrite(t *testing.T) {
	f := newFixture(t, false, false)
	b := sharedBackend(testNative(), f.left.Parent.Identity, uint32(unix.Geteuid()), 80, 0775)
	wantFailure(t, f.operation(false, b, nil).Run(context.Background()), "parent_replaced", false, false)
	assertEntry(t, f.left, f.le)
	assertAbsent(t, f.right)
}

func TestSharedParentMetadataSnapshot(t *testing.T) {
	for _, after := range []bool{false, true} {
		for _, attribute := range []string{"mode", "uid", "gid"} {
			t.Run(map[bool]string{false: "fence/", true: "effect/"}[after]+attribute, func(t *testing.T) {
				f := newFixture(t, true, false)
				parent := sharedLocation(t, f, false)
				native := testNative()
				changed := false
				effects := 0
				baseMode := uint32(0775)
				if attribute == "gid" {
					baseMode = 0755
				}
				b := sharedBackend(native, parent, 0, 80, baseMode)
				held := b.heldFn
				b.heldFn = func(fd int) (metadata, error) {
					m, e := held(fd)
					if changed && m.identity == parent {
						switch attribute {
						case "mode":
							m = sharedMetadata(m, 0, 80, 0755)
						case "uid":
							m = sharedMetadata(m, uint32(unix.Geteuid())+1, 80, 0775)
						case "gid":
							m = sharedMetadata(m, 0, 81, 0755)
						}
					}
					return m, e
				}
				b.moveFn = func(l int, ln string, r int, rn string, x bool) error {
					effects++
					err := native.move(l, ln, r, rn, x)
					if after {
						changed = true
					}
					return err
				}
				err := f.operation(true, b, func(context.Context) error {
					if !after {
						changed = true
					}
					return nil
				}).Run(context.Background())
				code := "parent_replaced"
				if after {
					code = "exchange_uncertain"
				}
				wantFailure(t, err, code, after, false)
				if !after && effects != 0 {
					t.Fatal("changed metadata dispatched")
				}
			})
		}
	}
}

func TestSharedParentCopiedRunRetainsBorrowedCustody(t *testing.T) {
	f := newFixture(t, false, false)
	parent := sharedLocation(t, f, false)
	native := testNative()
	b := sharedBackend(native, parent, 0, 80, 0775)
	entered, release := make(chan struct{}), make(chan struct{})
	returned := make(chan error, 1)
	var effects atomic.Int32
	b.moveFn = func(l int, ln string, r int, rn string, x bool) error {
		effects.Add(1)
		close(entered)
		<-release
		return native.move(l, ln, r, rn, x)
	}
	o := f.operation(false, b, nil)
	copy := *o
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { returned <- o.Run(ctx) }()
	<-entered
	wantFailure(t, copy.Run(context.Background()), "operation_consumed", true, false)
	cancel()
	select {
	case err := <-returned:
		t.Fatalf("abandoned native call: %v", err)
	default:
	}
	close(release)
	wantFailure(t, <-returned, "move_uncertain", true, false)
	if effects.Load() != 1 {
		t.Fatal("duplicate effect")
	}
	if got := fileIdentity(t, f.left.Parent.File); got != parent {
		t.Fatal("borrowed parent changed")
	}
	if _, err := os.Stat(filepath.Join(f.right.Parent.File.Name(), f.right.Name)); err != nil {
		t.Fatal(err)
	}
}
