package helperroutes

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

const operationID = "0123456789abcdef0123456789abcdef"

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func classified(t *testing.T, err error, code Code, internal bool) {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) || e.Code != code || e.Internal != internal {
		t.Fatalf("error = %#v, want %s internal=%v", err, code, internal)
	}
	if err.Error() != "helper routes: "+string(code) {
		t.Fatalf("unbounded message: %q", err.Error())
	}
}

type fixture struct {
	root, home, preview, update, operation, state string
	fs                                            filesystem
}

// This seam substitutes one fixed disposable physical root. It neither changes
// directory policy nor establishes real / ancestry or native Mac acceptance.
// In particular an EUID-owned fixture cannot pass the shared UID-0 root rule.
func newFixture(t *testing.T) fixture {
	t.Helper()
	root := t.TempDir()
	must(t, os.Chmod(root, 0700))
	f := fixture{root: root, home: root + "/home", fs: nativeFilesystem()}
	f.preview = f.home + "/Library/Application Support/io.github.legrch.farol"
	f.state = f.preview + "/farol-state"
	f.update = f.preview + "/installed-updates"
	f.operation = f.update + "/" + operationID
	for _, p := range []string{f.home + "/Applications", f.operation, f.state} {
		must(t, os.MkdirAll(p, 0700))
	}
	f.fs.rootOpen = func() (int, error) { return unix.Open(root, directoryFlags, 0) }
	f.fs.rootStat = func(s *unix.Stat_t) error { return unix.Fstatat(unix.AT_FDCWD, root, s, unix.AT_SYMLINK_NOFOLLOW) }
	return f
}
func (f fixture) open(t *testing.T) *Routes {
	t.Helper()
	r, err := openExisting(context.Background(), "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
	must(t, err)
	t.Cleanup(func() { must(t, r.Close()) })
	return r
}

func TestExistingRoutesAndContentChanges(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	must(t, r.Verify(context.Background()))
	must(t, r.WithFiles(context.Background(), func(files Files) error {
		if files.SharedParent {
			t.Fatal("legacy shared role")
		}
		for _, pair := range []struct {
			file     *os.File
			identity Identity
		}{
			{files.Home, files.HomeIdentity}, {files.Applications, files.ApplicationsIdentity},
			{files.Update, files.UpdateIdentity}, {files.Operation, files.OperationIdentity}, {files.State, files.StateIdentity},
		} {
			var s unix.Stat_t
			must(t, unix.Fstat(int(pair.file.Fd()), &s))
			if metadata(s).identity() != pair.identity {
				t.Fatal("identity differs")
			}
		}
		// Caller-owned contents may change without changing route custody.
		must(t, os.Mkdir(f.operation+"/new-directory", 0700))
		must(t, os.WriteFile(f.update+"/new-file", []byte("content"), 0600))
		return nil
	}))
	must(t, r.Verify(context.Background()))
}

func TestValidation(t *testing.T) {
	for _, path := range []string{"", "/", "home", "/home/", "//home", "/./home", "/home/../x", "/h\x00", "/\xff", "/" + strings.Repeat("é", 128)} {
		t.Run(path, func(t *testing.T) {
			_, err := OpenExisting(context.Background(), path, operationID, "legacy", time.Now().Add(time.Minute))
			classified(t, err, CodeInvalid, false)
		})
	}
	for _, op := range []string{"", strings.Repeat("a", 31), strings.Repeat("a", 33), strings.Repeat("A", 32), strings.Repeat("g", 32), operationID[:31] + "/"} {
		_, err := OpenExisting(context.Background(), "/home", op, "legacy", time.Now().Add(time.Minute))
		classified(t, err, CodeInvalid, false)
	}
	for _, location := range []string{"", "Legacy", "SHARED", "other"} {
		_, err := OpenExisting(context.Background(), "/home", operationID, location, time.Now().Add(time.Minute))
		classified(t, err, CodeInvalid, false)
	}
	_, err := OpenExisting(context.Background(), "/home", operationID, "legacy", time.Time{})
	classified(t, err, CodeInvalid, false)
	_, err = OpenExisting(nil, "/home", operationID, "legacy", time.Now().Add(time.Minute))
	classified(t, err, CodeDependency, true)
	if !validHome("/"+strings.Repeat("x", 255)) || !validHome("/é/合法") {
		t.Fatal("valid canonical components refused")
	}
}

func TestProductionPhysicalRootHasNoCloudRelaxation(t *testing.T) {
	var stat unix.Stat_t
	must(t, unix.Fstatat(unix.AT_FDCWD, "/", &stat, unix.AT_SYMLINK_NOFOLLOW))
	want := metadata(stat).permitted(ancestor)
	if want == nil {
		t.Skip("physical root passes; disposable seam tests remain separate")
	}
	_, err := OpenExisting(context.Background(), "/workspace", operationID, "legacy", time.Now().Add(time.Minute))
	var e *Error
	if !errors.As(want, &e) {
		t.Fatal(want)
	}
	classified(t, err, e.Code, false)
}

func TestMissingNeverCreatedAndSymlinksNeverFollowed(t *testing.T) {
	for _, leaf := range []string{"home", "home/Applications", "home/Library", "home/Library/Application Support", "home/Library/Application Support/io.github.legrch.farol", "home/Library/Application Support/io.github.legrch.farol/farol-state", "home/Library/Application Support/io.github.legrch.farol/installed-updates", "home/Library/Application Support/io.github.legrch.farol/installed-updates/" + operationID} {
		for _, kind := range []string{"missing", "symlink", "file"} {
			t.Run(leaf+"/"+kind, func(t *testing.T) {
				f := newFixture(t)
				path := f.root + "/" + leaf
				must(t, os.Rename(path, path+"-held"))
				if kind == "symlink" {
					must(t, os.Symlink(path+"-held", path))
				} else if kind == "file" {
					must(t, os.WriteFile(path, nil, 0600))
				}
				_, err := openExisting(context.Background(), "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
				want := CodeType
				if kind == "missing" {
					want = CodeMissing
				}
				classified(t, err, want, kind == "missing")
				if kind == "missing" {
					_, err := os.Lstat(path)
					if !os.IsNotExist(err) {
						t.Fatalf("missing directory created: %v", err)
					}
				}
			})
		}
	}
}

func TestEveryHeldComponentAndNamedRoutePinned(t *testing.T) {
	for _, selected := range []string{"root", "home", "applications", "library", "support", "preview", "state", "update", "operation"} {
		for _, change := range []string{"mode", "replace", "detach", "symlink"} {
			t.Run(selected+"/"+change, func(t *testing.T) {
				f := newFixture(t)
				r := f.open(t)
				paths := map[string]string{"root": f.root, "home": f.home, "applications": f.home + "/Applications", "library": f.home + "/Library", "support": f.home + "/Library/Application Support", "preview": f.preview, "state": f.state, "update": f.update, "operation": f.operation}
				path := paths[selected]
				if selected == "root" && change != "mode" {
					// Moving the fixture root outside TempDir's cleanup custody
					// requires a sibling restoration at test return.
					defer func() { _ = os.RemoveAll(path); _ = os.Rename(path+"-moved", path) }()
				}
				switch change {
				case "mode":
					must(t, os.Chmod(path, 0750)) // still policy-safe, but identity differs.
				case "replace", "detach", "symlink":
					must(t, os.Rename(path, path+"-moved"))
					if change == "replace" {
						must(t, os.Mkdir(path, 0700))
					}
					if change == "symlink" {
						must(t, os.Symlink(path+"-moved", path))
					}
				}
				err := r.Verify(context.Background())
				if err == nil {
					t.Fatal("changed component accepted")
				}
				var e *Error
				if !errors.As(err, &e) || e.Internal != (change == "detach") {
					t.Fatalf("change classification: %#v", err)
				}
			})
		}
	}
}

func TestOwnerAndModePredicatesStayRoleSpecific(t *testing.T) {
	uid := uint32(unix.Geteuid())
	for _, tc := range []struct {
		name           string
		r              role
		uid, gid, mode uint32
		code           Code
	}{
		{"ancestor-euid", ancestor, uid, 1, 0755, ""}, {"ancestor-root", ancestor, 0, 1, 0755, ""},
		{"ancestor-other", ancestor, uid + 1, 1, 0755, CodeOwner}, {"home-final-other", home, uid + 1, 1, 0700, CodeOwner},
		{"root-groupwrite", ancestor, uid, 1, 0775, CodeMode}, {"root-otherwrite", ancestor, uid, 1, 0757, CodeMode},
		{"owned-euid", owned, uid, 1, 0755, ""}, {"owned-groupwrite", owned, uid, 80, 0775, CodeMode},
		{"private", state, uid, 1, 0700, ""}, {"private-groupread", state, uid, 1, 0740, CodeMode},
		{"shared-root", sharedRoot, 0, 1, 0755, ""}, {"shared-root-groupwrite", sharedRoot, 0, 80, 0775, CodeMode},
		{"shared-apps", sharedApplications, 0, 80, 0775, ""}, {"shared-apps-nowrite", sharedApplications, 0, 1, 0755, ""},
		{"shared-wrong-group", sharedApplications, 0, 1, 0775, CodeMode}, {"shared-otherwrite", sharedApplications, 0, 80, 0777, CodeMode},
		{"shared-owner", sharedApplications, uid + 1, 80, 0775, CodeOwner},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := (fingerprint{mode: unix.S_IFDIR | tc.mode, uid: tc.uid, gid: tc.gid}).permitted(tc.r)
			if tc.code == "" {
				must(t, err)
			} else {
				classified(t, err, tc.code, false)
			}
		})
	}
	for _, r := range []role{ancestor, home, owned, state, sharedRoot, sharedApplications} {
		classified(t, (fingerprint{mode: unix.S_IFREG | 0700, uid: uid}).permitted(r), CodeType, false)
	}
	if uid != 0 {
		f := newFixture(t)
		_, err := openExisting(context.Background(), "/home", operationID, "shared", time.Now().Add(time.Minute), f.fs)
		classified(t, err, CodeOwner, false)
	}
}

func TestObservedGroupMetadataChangeRefuses(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	changed := false
	original := r.owner.fs.fstat
	// An actual chmod is exercised above. This syscall boundary supplies the
	// otherwise unavailable foreign UID/GID observation without claiming chown
	// privileges or native ownership acceptance on this host.
	r.owner.fs.fstat = func(fd int, s *unix.Stat_t) error {
		err := original(fd, s)
		if fd == r.owner.nodes[r.owner.operation].fd {
			s.Gid++
			changed = true
		}
		return err
	}
	classified(t, r.Verify(context.Background()), CodeChanged, false)
	if !changed {
		t.Fatal("metadata hook not reached")
	}
}

func TestCrossedOperationAndHomeNeverAccepted(t *testing.T) {
	f := newFixture(t)
	must(t, os.Mkdir(f.update+"/"+strings.Repeat("f", 32), 0700))
	r := f.open(t)
	must(t, os.Rename(f.operation, f.operation+"-old"))
	must(t, os.Rename(f.update+"/"+strings.Repeat("f", 32), f.operation))
	classified(t, r.Verify(context.Background()), CodeChanged, false)
	// A fresh owner may hold a newly existing route; the original owner cannot
	// silently transfer its pins to that operation or a different home.
	fresh := f.open(t)
	if reflect.DeepEqual(r.owner.files().OperationIdentity, fresh.owner.files().OperationIdentity) {
		t.Fatal("crossed operation identity")
	}
}

func TestNoMutationAndBorrowedDescriptionState(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	snapshot := func() map[string]fingerprint {
		out := map[string]fingerprint{}
		must(t, filepath.WalkDir(f.root, func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			var s unix.Stat_t
			if err := unix.Lstat(path, &s); err != nil {
				return err
			}
			out[path] = metadata(s)
			return nil
		}))
		return out
	}
	before := snapshot()
	n := r.owner.nodes[r.owner.operation]
	flags, err := unix.FcntlInt(uintptr(n.fd), unix.F_GETFL, 0)
	must(t, err)
	fdFlags, err := unix.FcntlInt(uintptr(n.fd), unix.F_GETFD, 0)
	must(t, err)
	offset, err := unix.Seek(n.fd, 0, 1)
	must(t, err)
	must(t, unix.Flock(n.fd, unix.LOCK_EX|unix.LOCK_NB))
	defer unix.Flock(n.fd, unix.LOCK_UN)
	// Darwin reports a sticky FHASLOCK status bit once a description has been
	// flocked, so the baseline must include the fixture's own lock.
	flags, err = unix.FcntlInt(uintptr(n.fd), unix.F_GETFL, 0)
	must(t, err)
	probe, err := os.Open(f.operation)
	must(t, err)
	defer probe.Close()
	for i := 0; i < 3; i++ {
		must(t, r.WithFiles(context.Background(), func(files Files) error {
			if files.Operation != n.file {
				t.Fatal("borrow changed description")
			}
			return nil
		}))
	}
	afterFlags, err := unix.FcntlInt(uintptr(n.fd), unix.F_GETFL, 0)
	must(t, err)
	afterFDFlags, err := unix.FcntlInt(uintptr(n.fd), unix.F_GETFD, 0)
	must(t, err)
	afterOffset, err := unix.Seek(n.fd, 0, 1)
	must(t, err)
	if flags != afterFlags || fdFlags != afterFDFlags || offset != afterOffset {
		t.Fatal("borrowed flags/offset changed")
	}
	if err := unix.Flock(int(probe.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != unix.EWOULDBLOCK && err != unix.EAGAIN {
		t.Fatalf("original lock changed: %v", err)
	}
	if !reflect.DeepEqual(before, snapshot()) {
		t.Fatal("filesystem mutated")
	}
}

func TestCopiesCloseOnceAndClosedOwner(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	copy := *r
	var mu sync.Mutex
	counts := map[*os.File]int{}
	r.owner.fs.close = func(file *os.File) error { mu.Lock(); counts[file]++; mu.Unlock(); return file.Close() }
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Go(func() { must(t, copy.Close()) })
	}
	wg.Wait()
	for _, n := range r.owner.nodes {
		if counts[n.file] != 1 {
			t.Fatalf("close count = %d", counts[n.file])
		}
	}
	classified(t, r.Verify(context.Background()), CodeClosed, false)
	classified(t, copy.WithFiles(context.Background(), func(Files) error { t.Fatal("closed callback"); return nil }), CodeClosed, false)
}

func TestBorrowCancellationAndCloseWaitForActualReturn(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	copy := *r
	ctx, cancel := context.WithCancel(context.Background())
	entered, release, result := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() { result <- r.WithFiles(ctx, func(Files) error { close(entered); <-release; return nil }) }()
	<-entered
	cancel()
	closed := make(chan error, 1)
	go func() { closed <- copy.Close() }()
	select {
	case err := <-result:
		t.Fatalf("abandoned callback: %v", err)
	default:
	}
	select {
	case err := <-closed:
		t.Fatalf("closed live callback: %v", err)
	default:
	}
	// A queued operation can cancel independently while callback owns the gate.
	waitCtx, waitCancel := context.WithCancel(context.Background())
	waitCancel()
	classified(t, r.Verify(waitCtx), CodeContext, false)
	for _, n := range r.owner.nodes {
		if _, err := n.file.Stat(); err != nil {
			t.Fatal("live file closed")
		}
	}
	close(release)
	err := <-result
	classified(t, err, CodeContext, false)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("lost context cause")
	}
	must(t, <-closed)
}

func TestCancelableGateWaitAndSerializedCallbacks(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		done <- r.WithFiles(context.Background(), func(Files) error { close(entered); <-release; return nil })
	}()
	<-entered
	ctx, cancel := context.WithCancel(context.Background())
	waiting := make(chan error, 1)
	go func() { waiting <- r.WithFiles(ctx, func(Files) error { t.Error("queued callback ran"); return nil }) }()
	cancel()
	err := <-waiting
	classified(t, err, CodeContext, false)
	close(release)
	must(t, <-done)
	var active, calls int
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Go(func() {
			must(t, r.WithFiles(context.Background(), func(Files) error {
				active++
				calls++
				if active != 1 {
					t.Error("overlapping callback")
				}
				active--
				return nil
			}))
		})
	}
	wg.Wait()
	if calls != 12 {
		t.Fatal(calls)
	}
}

func TestOriginalBudgetNeverRenewed(t *testing.T) {
	f := newFixture(t)
	until := time.Now().Add(time.Minute)
	initialDeadline := until.Add(-time.Second)
	initialCtx, initialCancel := context.WithDeadline(context.Background(), initialDeadline)
	defer initialCancel()
	r, err := openExisting(initialCtx, "/home", operationID, "legacy", until, f.fs)
	must(t, err)
	defer r.Close()
	if !r.owner.until.Equal(initialDeadline) {
		t.Fatal("opening context bound was not captured")
	}
	must(t, r.Verify(context.Background()))
	if !r.owner.until.Equal(initialDeadline) {
		t.Fatal("later call renewed budget")
	}
	// Advancing this captured bound in a test avoids a scheduler-sensitive wait;
	// no exported constructor/method can renew it.
	r.owner.until = time.Now().Add(-time.Second)
	err = r.WithFiles(context.Background(), func(Files) error { t.Fatal("expired callback"); return nil })
	classified(t, err, CodeContext, false)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("deadline cause")
	}
	_, err = openExisting(context.Background(), "/home", operationID, "legacy", time.Now().Add(-time.Second), f.fs)
	classified(t, err, CodeContext, false)
}

func TestCallbackCausesSurviveCancellationAndRouteChange(t *testing.T) {
	for _, cause := range []error{context.Canceled, context.DeadlineExceeded, unix.EIO, errors.New("private/path/native message"), errors.Join(context.Canceled, unix.EIO)} {
		f := newFixture(t)
		r := f.open(t)
		ctx, cancel := context.WithCancel(context.Background())
		err := r.WithFiles(ctx, func(Files) error { cancel(); return cause })
		classified(t, err, CodeCallback, internal(cause))
		if !errors.Is(err, cause) || !errors.Is(err, context.Canceled) {
			t.Fatal("callback/context cause erased")
		}
	}
	f := newFixture(t)
	r := f.open(t)
	cause := errors.New("exact dependency cause")
	err := r.WithFiles(context.Background(), func(Files) error { must(t, os.Chmod(f.update, 0750)); return cause })
	classified(t, err, CodeCallback, true)
	if !errors.Is(err, cause) {
		t.Fatal("postcallback verification erased cause")
	}
	var nilRoutes *Routes
	classified(t, nilRoutes.Verify(context.Background()), CodeDependency, true)
	classified(t, (&Routes{}).Close(), CodeDependency, true)
	classified(t, r.WithFiles(context.Background(), nil), CodeDependency, true)
}
